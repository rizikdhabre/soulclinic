import { NextResponse } from "next/server";
import { normalizeIsraeliPhone } from "@/lib/phone";
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

function getOtpConfigErrorResponse() {
  return NextResponse.json(
    {
      error: "OTP_SERVICE_NOT_CONFIGURED",
      message: "OTP service is not configured.",
    },
    { status: 500 },
  );
}

export async function POST(req) {
  try {
    const { phone: rawPhone, code } = await req.json();
    const phone = normalizeIsraeliPhone(rawPhone);
    const otpCode = String(code || "").trim();

    if (!phone || !otpCode) {
      return getInvalidOtpResponse();
    }

    const approved = await verifyPhoneCode(phone, otpCode);

    console.info("OTP verify request completed", {
      provider: getOtpProvider(),
      approved,
    });

    if (!approved) {
      return getInvalidOtpResponse();
    }

    return NextResponse.json({
      success: true,
      provider: getOtpProvider(),
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
    });

    if (error?.status === 400 || error?.status === 404) {
      return getInvalidOtpResponse();
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
