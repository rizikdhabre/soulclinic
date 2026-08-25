import { NextResponse } from "next/server";
import { OtpError } from "@/lib/otp/errors";
import { requestTwilioFallback } from "@/lib/otp/twilioFallback";

const SAFE_MESSAGES = {
  OTP_CHALLENGE_FAILED: "Invalid or expired OTP challenge.",
  OTP_FALLBACK_ALREADY_USED: "OTP fallback has already been requested.",
  OTP_FALLBACK_FAILED: "Failed to request OTP fallback.",
  OTP_FALLBACK_NOT_ALLOWED: "OTP fallback is not available for this request.",
  OTP_FALLBACK_SOURCE_RATE_LIMITED: "OTP fallback rate limit exceeded.",
  OTP_SEND_FAILED: "Failed to send OTP.",
  OTP_SEND_PENDING:
    "The verification request may still be processing. Please wait before trying again.",
  OTP_SEND_RETRIES_EXHAUSTED: "Failed to send OTP after multiple attempts.",
  OTP_SERVICE_NOT_CONFIGURED: "OTP service is not configured.",
  OTP_SOURCE_UNAVAILABLE: "OTP source identity is unavailable.",
  OTP_STATE_BUSY: "OTP security state is busy.",
};

function errorResponse(code, status, retryAfterSeconds) {
  return NextResponse.json(
    {
      error: code,
      message: SAFE_MESSAGES[code],
      ...(retryAfterSeconds ? { retryAfterSeconds } : {}),
    },
    { status },
  );
}

export async function POST(request) {
  let payload;
  try {
    payload = await request.json();
  } catch {
    return errorResponse("OTP_FALLBACK_FAILED", 400);
  }

  if (
    typeof payload?.challengeToken !== "string" ||
    !payload.challengeToken ||
    typeof payload?.firebaseErrorCode !== "string" ||
    !payload.firebaseErrorCode
  ) {
    return errorResponse("OTP_FALLBACK_FAILED", 400);
  }

  try {
    const result = await requestTwilioFallback({
      request,
      challengeToken: payload.challengeToken,
      firebaseErrorCode: payload.firebaseErrorCode,
    });
    return NextResponse.json({ provider: result.provider, status: result.status });
  } catch (error) {
    if (error instanceof OtpError && SAFE_MESSAGES[error.code]) {
      return errorResponse(error.code, error.status, error.retryAfterSeconds);
    }
    return errorResponse("OTP_FALLBACK_FAILED", 500);
  }
}
