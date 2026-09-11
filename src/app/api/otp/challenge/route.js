import { NextResponse } from "next/server";
import { createOtpChallenge } from "@/lib/otp/challengeService";
import { OtpError, otpErrorMetadata } from "@/lib/otp/errors";

const SAFE_MESSAGES = {
  INVALID_PHONE: "Invalid phone number.",
  INVALID_OTP_PURPOSE: "Invalid OTP purpose.",
  OTP_RATE_LIMITED: "OTP request rate limit exceeded.",
  OTP_SOURCE_RATE_LIMITED: "OTP challenge rate limit exceeded.",
  OTP_SOURCE_UNAVAILABLE: "OTP source identity is unavailable.",
  OTP_SERVICE_NOT_CONFIGURED: "OTP service is not configured.",
  OTP_CHALLENGE_FAILED: "Failed to create OTP challenge.",
  OTP_PERSISTENCE_FAILED: "OTP state could not be saved or read.",
  OTP_STATE_BUSY: "OTP security state is busy.",
};

function errorResponse(code, status, error) {
  const trusted = error instanceof OtpError ? error : undefined;
  const metadata = otpErrorMetadata(trusted);
  const headers = { "Cache-Control": "no-store" };
  if (status === 429 && metadata.retryAfterSeconds) {
    headers["Retry-After"] = String(metadata.retryAfterSeconds);
  }
  return NextResponse.json(
    {
      error: code,
      message: SAFE_MESSAGES[code],
      ...metadata,
      ...(boundedString(trusted?.recoveryReceipt, 2048) ? { recoveryReceipt: trusted.recoveryReceipt } : {}),
    },
    { status, headers },
  );
}

function boundedString(value, max) {
  return typeof value === "string" && value.length <= max && value.trim().length > 0;
}

export async function POST(request) {
  let payload;
  try {
    payload = await request.json();
  } catch {
    return errorResponse("OTP_CHALLENGE_FAILED", 400);
  }

  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return errorResponse("OTP_CHALLENGE_FAILED", 400);
  }
  if (!boundedString(payload.phone, 32)) return errorResponse("INVALID_PHONE", 400);
  if (payload.purpose !== "booking" && payload.purpose !== "login") {
    return errorResponse("INVALID_OTP_PURPOSE", 400);
  }

  try {
    const result = await createOtpChallenge({
      request,
      phone: payload?.phone,
      purpose: payload?.purpose,
    });
    return NextResponse.json({
      challengeToken: result.challengeToken,
      provider: "twilio",
      expiresAt: result.expiresAt,
      ...otpErrorMetadata(result),
    }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    if (error instanceof OtpError && Object.hasOwn(SAFE_MESSAGES, error.code)) {
      const status = Number.isInteger(error.status) && error.status >= 400 && error.status <= 599 ? error.status : 500;
      return errorResponse(error.code, status, error);
    }
    return errorResponse("OTP_CHALLENGE_FAILED", 500, error);
  }
}
