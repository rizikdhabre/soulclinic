import { NextResponse } from "next/server";
import { createOtpChallenge } from "@/lib/otp/challengeService";
import { OtpError, otpErrorMetadata } from "@/lib/otp/errors";

const SAFE_MESSAGES = {
  INVALID_PHONE: "Invalid phone number.",
  INVALID_OTP_PURPOSE: "Invalid OTP purpose.",
  OTP_RATE_LIMITED: "OTP request rate limit exceeded.",
  OTP_SOURCE_RATE_LIMITED: "OTP challenge rate limit exceeded.",
  OTP_SOURCE_UNAVAILABLE: "OTP source identity is unavailable.",
  OTP_CHALLENGE_FAILED: "Failed to create OTP challenge.",
  OTP_PERSISTENCE_FAILED: "OTP state could not be saved or read.",
  OTP_STATE_BUSY: "OTP security state is busy.",
};

function errorResponse(code, status, error) {
  return NextResponse.json(
    {
      error: code,
      message: SAFE_MESSAGES[code],
      ...otpErrorMetadata(error),
    },
    { status },
  );
}

export async function POST(request) {
  let payload;
  try {
    payload = await request.json();
  } catch {
    return errorResponse("OTP_CHALLENGE_FAILED", 400);
  }

  try {
    const result = await createOtpChallenge({
      request,
      phone: payload?.phone,
      purpose: payload?.purpose,
    });
    return NextResponse.json(result);
  } catch (error) {
    if (error instanceof OtpError && SAFE_MESSAGES[error.code]) {
      return errorResponse(error.code, error.status, error);
    }
    return errorResponse("OTP_CHALLENGE_FAILED", 500);
  }
}
