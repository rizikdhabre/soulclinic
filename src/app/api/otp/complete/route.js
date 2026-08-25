import { NextResponse } from "next/server";
import { setCustomerSessionCookie } from "@/lib/customerSession";
import { completeOtpChallenge } from "@/lib/otp/completionService";

const SAFE_ERRORS = {
  OTP_REQUEST_INVALID: [400, "Invalid OTP completion request."],
  OTP_CHALLENGE_TOKEN_REQUIRED: [400, "OTP challenge token is required."],
  OTP_PROVIDER_REQUIRED: [400, "OTP provider is required."],
  OTP_PROVIDER_MISMATCH: [400, "OTP provider mismatch."],
  OTP_EVIDENCE_REQUIRED: [400, "OTP evidence is required."],
  OTP_VERIFICATION_INVALID: [401, "OTP verification is invalid."],
  OTP_VERIFICATION_EXPIRED: [401, "OTP verification has expired."],
  INVALID_FIREBASE_TOKEN: [401, "Invalid Firebase phone verification."],
  INVALID_OTP: [401, "Invalid verification code."],
  OTP_CHALLENGE_ALREADY_COMPLETED: [
    409,
    "OTP challenge is already completed.",
  ],
  OTP_COMPLETION_IN_PROGRESS: [409, "OTP completion is in progress."],
  OTP_VERIFY_RATE_LIMITED: [429, "OTP verification rate limit exceeded."],
  OTP_LOGIN_COMPLETION_UNAVAILABLE: [
    503,
    "OTP login completion is unavailable.",
  ],
  OTP_DEVELOPMENT_COMPLETION_UNAVAILABLE: [
    503,
    "Development OTP completion is unavailable.",
  ],
  OTP_VERIFY_TEMPORARY_FAILURE: [
    503,
    "OTP verification is temporarily unavailable.",
  ],
  OTP_VERIFY_FAILED: [503, "OTP verification failed."],
  OTP_SERVICE_NOT_CONFIGURED: [503, "OTP verification is unavailable."],
  CUSTOMER_SESSION_NOT_CONFIGURED: [503, "Customer session is unavailable."],
  OTP_STATE_BUSY: [503, "OTP security state is busy."],
  OTP_COMPLETION_FAILED: [500, "OTP completion failed."],
};

function errorResponse(code) {
  const safeCode = Object.hasOwn(SAFE_ERRORS, code)
    ? code
    : "OTP_COMPLETION_FAILED";
  const [status, message] = SAFE_ERRORS[safeCode];
  return NextResponse.json(
    { success: false, error: { code: safeCode, message } },
    { status },
  );
}

function selectPayload(body) {
  const payload = {
    challengeToken: body?.challengeToken,
    provider: body?.provider,
  };

  if (body?.provider === "firebase") payload.idToken = body.idToken;
  if (body?.provider === "twilio" || body?.provider === "development") {
    payload.code = body.code;
  }
  return payload;
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

  try {
    const result = await completeOtpChallenge(selectPayload(body));
    if (result.purpose === "login") {
      const response = NextResponse.json({ success: true, purpose: "login" });
      setCustomerSessionCookie(
        response,
        result.sessionToken,
        result.sessionTtlSeconds,
      );
      return response;
    }
    return NextResponse.json(selectBookingSuccess(result));
  } catch (error) {
    return errorResponse(error?.code);
  }
}
