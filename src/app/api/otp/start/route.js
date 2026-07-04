import { NextResponse } from "next/server";
import { normalizeIsraeliPhone } from "@/lib/phone";
import {
  getOtpExpiresAt,
  getOtpProvider,
  getOtpSuccessMessage,
  getStoredOtpCode,
  sendPhoneVerification,
} from "@/lib/twilioOTP";

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
    const { phone: rawPhone } = await req.json();
    const phone = normalizeIsraeliPhone(rawPhone);

    if (!phone) {
      return NextResponse.json(
        {
          error: "INVALID_PHONE",
          message: "Invalid phone number.",
        },
        { status: 400 },
      );
    }

    const expiresAt = getOtpExpiresAt();
    const storedOtpCode = getStoredOtpCode();
    const verification = await sendPhoneVerification(phone);

    console.info("OTP start request completed", {
      provider: verification.provider || getOtpProvider(),
    });

    return NextResponse.json({
      success: true,
      provider: verification.provider,
      status: verification.status,
      expiresAt: expiresAt.toISOString(),
      mode: storedOtpCode === "twilio-verify" ? "twilio" : "development",
      message: getOtpSuccessMessage(),
    });
  } catch (error) {
    if (error?.code === "TWILIO_VERIFY_NOT_CONFIGURED") {
      return getOtpConfigErrorResponse();
    }

    console.error("OTP start failed:", {
      provider: getOtpProvider(),
      code: error?.code,
      status: error?.status,
      message: error?.message,
    });

    return NextResponse.json(
      {
        error: "OTP_SEND_FAILED",
        message: "Failed to send OTP.",
      },
      { status: error?.status === 400 ? 400 : 500 },
    );
  }
}
