import { NextResponse } from "next/server";
import { normalizeIsraeliPhone } from "@/lib/phone";
import {
  clearOtpVerifyFailures,
  createOtpVerificationGrant,
  getRecentOtpVerifyFailureLimit,
  maskPhone,
  recordOtpVerifyFailure,
} from "@/lib/otpSecurity";
import { getOtpProvider, verifyPhoneCode } from "@/lib/twilioOTP";

function getInvalidOtpResponse() {
  return NextResponse.json(
    {
      error: "INVALID_OTP",
      message: "Invalid OTP.",
    },
    { status: 401 },
  );
}

function getInvalidPhoneResponse() {
  return NextResponse.json(
    {
      error: "INVALID_PHONE",
      message: "Invalid phone number.",
    },
    { status: 400 },
  );
}

function getOtpConfigErrorResponse() {
  return NextResponse.json(
    {
      error: "OTP_SERVICE_NOT_CONFIGURED",
      message: "OTP service is not configured.",
    },
    { status: 500 },
  );
}

function getVerifyRateLimitResponse(retryAfterSeconds) {
  return NextResponse.json(
    {
      error: "OTP_VERIFY_RATE_LIMITED",
      message: "Too many incorrect verification attempts.",
      retryAfterSeconds,
    },
    { status: 429 },
  );
}

export async function POST(req) {
  let phone = null;

  try {
    const { phone: rawPhone, code } = await req.json();
    phone = normalizeIsraeliPhone(rawPhone);
    const otpCode = String(code || "").trim();

    if (!phone) {
      return getInvalidPhoneResponse();
    }

    if (!otpCode) {
      return getInvalidOtpResponse();
    }

    const failureLimit = await getRecentOtpVerifyFailureLimit(phone);

    if (failureLimit.limited) {
      return getVerifyRateLimitResponse(failureLimit.retryAfterSeconds);
    }

    const approved = await verifyPhoneCode(phone, otpCode);

    console.info("OTP verify request completed", {
      provider: getOtpProvider(),
      approved,
      phone: maskPhone(phone),
    });

    if (!approved) {
      await recordOtpVerifyFailure(phone, "INVALID_OTP");
      return getInvalidOtpResponse();
    }

    await clearOtpVerifyFailures(phone);
    const grant = await createOtpVerificationGrant(phone);

    return NextResponse.json({
      success: true,
      provider: getOtpProvider(),
      verificationToken: grant.verificationToken,
      expiresInSeconds: grant.expiresInSeconds,
    });
  } catch (error) {
    if (error?.code === "TWILIO_VERIFY_NOT_CONFIGURED") {
      return getOtpConfigErrorResponse();
    }

    console.error("OTP verify failed:", {
      provider: getOtpProvider(),
      code: error?.code,
      status: error?.status,
      message: error?.message,
      phone: phone ? maskPhone(phone) : null,
    });

    if (error?.status === 400 || error?.status === 404) {
      if (phone) {
        await recordOtpVerifyFailure(phone, "INVALID_OTP");
      }

      return getInvalidOtpResponse();
    }

    if (error?.status === 429) {
      return getVerifyRateLimitResponse(300);
    }

    return NextResponse.json(
      {
        error: "OTP_VERIFY_FAILED",
        message: "Failed to verify OTP.",
      },
      { status: 500 },
    );
  }
}
