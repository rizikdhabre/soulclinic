const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ISO_UTC_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const STAGES = new Set(["challenge", "firebase", "firebase_send", "fallback", "twilio", "complete", "configuration"]);
const PROVIDERS = new Set(["firebase", "twilio", "development"]);
const DECISIONS = new Set(["started", "reserved", "succeeded", "success", "failed", "blocked", "reject", "fallback"]);
const ERROR_CODES = new Set([
  "INVALID_PHONE", "INVALID_OTP_PURPOSE", "INVALID_OTP",
  "OTP_RATE_LIMITED", "OTP_SOURCE_RATE_LIMITED", "OTP_FALLBACK_SOURCE_RATE_LIMITED",
  "OTP_VERIFY_RATE_LIMITED", "OTP_SOURCE_UNAVAILABLE", "OTP_STATE_BUSY",
  "OTP_RATE_LIMIT_CONFIG_INVALID", "OTP_CHALLENGE_FAILED", "OTP_CHALLENGE_EXPIRED",
  "OTP_FALLBACK_ALREADY_USED", "OTP_FALLBACK_NOT_ALLOWED", "OTP_FALLBACK_FAILED",
  "OTP_SEND_FAILED", "OTP_SEND_PENDING", "OTP_SEND_RETRIES_EXHAUSTED",
  "OTP_SERVICE_NOT_CONFIGURED", "OTP_PROVIDER_REJECTED", "OTP_PERSISTENCE_FAILED",
  "OTP_VERIFY_FAILED", "OTP_VERIFY_TEMPORARY_FAILURE", "OTP_COMPLETE_FAILED",
  "OTP_FIREBASE_SEND_FAILED", "OTP_FLOW_CANCELLED", "otp/recaptcha-setup-failed",
  "auth/internal-error", "auth/operation-not-allowed", "auth/app-not-authorized",
  "auth/unauthorized-domain", "auth/too-many-requests", "auth/invalid-phone-number",
  "auth/missing-phone-number", "auth/invalid-verification-code", "auth/code-expired",
  "auth/quota-exceeded", "auth/captcha-check-failed", "auth/missing-app-credential",
  "auth/invalid-app-credential", "auth/network-request-failed", "auth/unknown",
  "auth/recaptcha-not-enabled", "auth/missing-recaptcha-token", "auth/invalid-recaptcha-token",
  "auth/invalid-recaptcha-action", "auth/missing-client-type", "auth/missing-recaptcha-version",
  "auth/invalid-recaptcha-version", "auth/invalid-req-type",
]);

export function isOtpCorrelationId(value) {
  return typeof value === "string" && UUID_PATTERN.test(value);
}

export function isOtpIsoTime(value) {
  return typeof value === "string" && ISO_UTC_PATTERN.test(value) &&
    Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
}

// Explicit values only: never project messages, provider payloads, or arbitrary codes.
export function logOtpEvent(input = {}) {
  const event = {};
  if (isOtpCorrelationId(input?.correlationId)) event.correlationId = input.correlationId;
  if (STAGES.has(input?.stage)) event.stage = input.stage;
  if (PROVIDERS.has(input?.provider)) event.provider = input.provider;
  if (ERROR_CODES.has(input?.errorCode)) event.errorCode = input.errorCode;
  if (DECISIONS.has(input?.decision)) event.decision = input.decision;
  if (input?.restrictionScope === "phone" || input?.restrictionScope === "source") {
    event.restrictionScope = input.restrictionScope;
  }
  if (isOtpIsoTime(input?.retryAt)) event.retryAt = input.retryAt;
  if (Number.isInteger(input?.retryAfterSeconds) && input.retryAfterSeconds > 0 && input.retryAfterSeconds <= 3600) {
    event.retryAfterSeconds = input.retryAfterSeconds;
  }
  if (Object.keys(event).length === 0) return;
  try {
    console.info("OTP flow", event);
  } catch {
    // Diagnostics must not change the send or reservation outcome.
  }
}
