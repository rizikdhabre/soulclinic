import { NextResponse } from "next/server";
import { setCustomerSessionCookie } from "@/lib/customerSession";
import { completeOtpChallenge } from "@/lib/otp/completionService";
import { OtpError, otpErrorMetadata } from "@/lib/otp/errors";

const SAFE_ERRORS = {
  OTP_REQUEST_INVALID: [400, "Invalid OTP completion request."],
  OTP_CHALLENGE_TOKEN_REQUIRED: [400, "OTP challenge token is required."],
  INVALID_OTP_PURPOSE: [400, "Invalid OTP purpose."],
  OTP_PURPOSE_MISMATCH: [400, "OTP purpose mismatch."],
  OTP_RECOVERY_INVALID: [400, "Invalid verification recovery receipt."],
  OTP_EVIDENCE_REQUIRED: [400, "OTP evidence is required."],
  OTP_PROVIDER_REJECTED: [400, "OTP provider does not own this challenge."],
  OTP_VERIFICATION_REQUIRED: [401, "OTP verification is required."],
  OTP_VERIFICATION_INVALID: [401, "OTP verification is invalid."],
  OTP_VERIFICATION_EXPIRED: [401, "OTP verification has expired."],
  OTP_VERIFICATION_ALREADY_USED: [401, "OTP verification was already used."],
  INVALID_OTP: [401, "Invalid verification code."],
  OTP_CHALLENGE_ALREADY_COMPLETED: [
    409,
    "OTP challenge is already completed.",
  ],
  OTP_COMPLETION_IN_PROGRESS: [409, "OTP completion is in progress."],
  OTP_VERIFY_RATE_LIMITED: [429, "OTP verification rate limit exceeded."],
  OTP_SEND_BUDGET_EXCEEDED: [429, "OTP send budget exceeded."],
  OTP_LOGIN_COMPLETION_UNAVAILABLE: [
    503,
    "OTP login completion is unavailable.",
  ],
  OTP_VERIFY_TEMPORARY_FAILURE: [
    503,
    "OTP verification is temporarily unavailable.",
  ],
  OTP_VERIFY_FAILED: [503, "OTP verification failed."],
  OTP_SERVICE_NOT_CONFIGURED: [503, "OTP verification is unavailable."],
  CUSTOMER_SESSION_NOT_CONFIGURED: [503, "Customer session is unavailable."],
  OTP_STATE_BUSY: [503, "OTP security state is busy."],
  OTP_PERSISTENCE_FAILED: [503, "OTP state could not be saved or read."],
  OTP_COMPLETION_FAILED: [500, "OTP completion failed."],
};

function errorResponse(code, error) {
  const safeCode = Object.hasOwn(SAFE_ERRORS, code)
    ? code
    : "OTP_COMPLETION_FAILED";
  const [defaultStatus, message] = SAFE_ERRORS[safeCode];
  const trusted = error instanceof OtpError ? error : undefined;
  const status = trusted && safeCode === code && Number.isInteger(trusted.status) && trusted.status >= 400 && trusted.status <= 599
    ? trusted.status : defaultStatus;
  const metadata = otpErrorMetadata(trusted);
  const headers = { "Cache-Control": "no-store" };
  if (status === 429 && metadata.retryAfterSeconds) headers["Retry-After"] = String(metadata.retryAfterSeconds);
  return NextResponse.json(
    {
      success: false,
      error: { code: safeCode, message },
      ...metadata,
      ...(safeCode === "OTP_VERIFY_TEMPORARY_FAILURE" && trusted?.firebaseFallbackAllowed === true ? { firebaseFallbackAllowed: true } : {}),
      ...(boundedString(trusted?.recoveryReceipt, 2048) ? { recoveryReceipt: trusted.recoveryReceipt } : {}),
    },
    { status, headers },
  );
}

function boundedString(value, max) {
  return typeof value === "string" && value.length <= max && value.trim().length > 0;
}

function selectPayload(body) {
  if (!body || typeof body !== "object" || Array.isArray(body) ||
    typeof body.challengeToken !== "string" || !/^[\w-]{43}$/.test(body.challengeToken) ||
    (body.purpose !== "booking" && body.purpose !== "login") ||
    (body.recoveryReceipt !== undefined && !boundedString(body.recoveryReceipt, 2048)) ||
    (body.idToken !== undefined && !boundedString(body.idToken, 16384)) ||
    (body.code !== undefined && body.code !== "" &&
      (typeof body.code !== "string" || !/^\d{4,10}$/.test(body.code)))) {
    return null;
  }
  return {
    challengeToken: body.challengeToken,
    purpose: body.purpose,
    code: body.code,
    ...(body.idToken === undefined ? {} : { idToken: body.idToken }),
    ...(body.recoveryReceipt === undefined ? {} : { recoveryReceipt: body.recoveryReceipt }),
  };
}

function selectProfile(profile) {
  if (profile?.hasCompleteName !== true) return { hasCompleteName: false };
  return {
    hasCompleteName: true,
    firstName: profile.firstName,
    lastName: profile.lastName,
  };
}

function selectBookingSuccess(result) {
  return {
    success: true,
    purpose: "booking",
    verificationToken: result.verificationToken,
    expiresInSeconds: result.expiresInSeconds,
    profile: selectProfile(result.profile),
  };
}

export async function POST(request) {
  let body;
  try {
    body = await request.json();
  } catch {
    return errorResponse("OTP_REQUEST_INVALID");
  }

  const payload = selectPayload(body);
  if (!payload) return errorResponse("OTP_REQUEST_INVALID");

  try {
    const result = await completeOtpChallenge(payload);
    if (result?.purpose !== payload.purpose) return errorResponse("OTP_COMPLETION_FAILED");
    if (result.purpose === "login") {
      if (!boundedString(result.sessionToken, 4096) || !Number.isSafeInteger(result.sessionTtlSeconds) || result.sessionTtlSeconds <= 0) {
        return errorResponse("OTP_COMPLETION_FAILED");
      }
      const response = NextResponse.json({ success: true, purpose: "login" }, { headers: { "Cache-Control": "no-store" } });
      setCustomerSessionCookie(
        response,
        result.sessionToken,
        result.sessionTtlSeconds,
      );
      return response;
    }
    return NextResponse.json(selectBookingSuccess(result), { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return errorResponse(error instanceof OtpError ? error.code : "OTP_COMPLETION_FAILED", error);
  }
}
