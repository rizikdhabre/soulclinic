import { NextResponse } from "next/server";
import { OtpError, otpErrorMetadata } from "@/lib/otp/errors";
import { requestTwilioSend } from "@/lib/otp/twilioSend";

const SAFE_MESSAGES = {
  OTP_CHALLENGE_FAILED: "Invalid or expired OTP challenge.",
  OTP_CHALLENGE_EXPIRED: "OTP challenge has expired.",
  OTP_RECOVERY_INVALID: "Invalid verification recovery receipt.",
  OTP_PROVIDER_REJECTED: "The OTP provider rejected the request.",
  OTP_PERSISTENCE_FAILED: "OTP state could not be saved or read.",
  OTP_RATE_LIMITED: "OTP request rate limit exceeded.",
  OTP_SEND_SOURCE_RATE_LIMITED: "OTP send rate limit exceeded.",
  OTP_SEND_BUDGET_EXCEEDED: "OTP send budget exceeded.",
  OTP_SEND_FAILED: "Failed to request OTP send.",
  OTP_SEND_PENDING: "The verification request may still be processing. Please wait before trying again.",
  OTP_SERVICE_NOT_CONFIGURED: "OTP service is not configured.",
  OTP_SOURCE_UNAVAILABLE: "OTP source identity is unavailable.",
  OTP_STATE_BUSY: "OTP security state is busy.",
};

function boundedReceipt(value) {
  return typeof value === "string" && value.length <= 2048 && value.trim().length > 0;
}

function errorResponse(code, status, error) {
  const trusted = error instanceof OtpError ? error : undefined;
  const metadata = otpErrorMetadata(trusted);
  const headers = { "Cache-Control": "no-store" };
  if (status === 429 && metadata.retryAfterSeconds) headers["Retry-After"] = String(metadata.retryAfterSeconds);
  return NextResponse.json({
    error: code,
    message: SAFE_MESSAGES[code],
    ...metadata,
    ...(boundedReceipt(trusted?.recoveryReceipt) ? { recoveryReceipt: trusted.recoveryReceipt } : {}),
    ...(trusted?.restartAllowed === true ? { restartAllowed: true } : {}),
  }, { status, headers });
}

export async function POST(request) {
  let payload;
  try {
    payload = await request.json();
  } catch {
    return errorResponse("OTP_SEND_FAILED", 400);
  }

  if (!payload || typeof payload !== "object" || Array.isArray(payload) ||
    typeof payload.challengeToken !== "string" || !/^[\w-]{43}$/.test(payload.challengeToken) ||
    (payload.recoveryReceipt !== undefined && !boundedReceipt(payload.recoveryReceipt))) {
    return errorResponse("OTP_SEND_FAILED", 400);
  }

  try {
    const result = await requestTwilioSend({
      request,
      challengeToken: payload.challengeToken,
      ...(payload.recoveryReceipt === undefined ? {} : { recoveryReceipt: payload.recoveryReceipt }),
    });
    if (result?.provider !== "twilio" || result?.status !== "pending") {
      return errorResponse("OTP_SEND_PENDING", 503);
    }
    return NextResponse.json({ provider: "twilio", status: "pending" }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    if (error instanceof OtpError && Object.hasOwn(SAFE_MESSAGES, error.code)) {
      const status = Number.isInteger(error.status) && error.status >= 400 && error.status <= 599 ? error.status : 500;
      return errorResponse(error.code, status, error);
    }
    return errorResponse("OTP_SEND_FAILED", 500, error);
  }
}
