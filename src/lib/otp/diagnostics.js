const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ISO_UTC_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const STAGES = new Set(["challenge", "send", "verify", "complete", "configuration"]);
const DECISIONS = new Set(["started", "reserved", "success", "failed", "blocked", "reject", "recovered"]);
const ERROR_CODES = new Set([
  "INVALID_PHONE", "INVALID_OTP_PURPOSE", "INVALID_OTP", "OTP_RATE_LIMITED",
  "OTP_SOURCE_RATE_LIMITED", "OTP_SEND_SOURCE_RATE_LIMITED", "OTP_SEND_BUDGET_EXCEEDED",
  "OTP_VERIFY_RATE_LIMITED", "OTP_SOURCE_UNAVAILABLE", "OTP_STATE_BUSY",
  "OTP_RATE_LIMIT_CONFIG_INVALID", "OTP_CHALLENGE_FAILED", "OTP_CHALLENGE_EXPIRED",
  "OTP_SEND_FAILED", "OTP_SEND_PENDING", "OTP_SERVICE_NOT_CONFIGURED",
  "OTP_PROVIDER_REJECTED", "OTP_PERSISTENCE_FAILED", "OTP_VERIFY_FAILED",
  "OTP_VERIFY_TEMPORARY_FAILURE", "OTP_COMPLETION_FAILED", "OTP_COMPLETION_IN_PROGRESS",
  "OTP_FLOW_CANCELLED", "OTP_RECOVERY_INVALID", "OTP_PURPOSE_MISMATCH",
  "OTP_VERIFICATION_INVALID", "OTP_VERIFICATION_EXPIRED", "OTP_VERIFICATION_ALREADY_USED",
]);

export function isOtpCorrelationId(value) {
  return typeof value === "string" && UUID_PATTERN.test(value);
}
export function isOtpIsoTime(value) {
  return typeof value === "string" && ISO_UTC_PATTERN.test(value) &&
    Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
}

// Never project phone numbers, provider payloads, tokens, receipts, or raw errors.
export function logOtpEvent(input = {}) {
  const event = {};
  if (isOtpCorrelationId(input.correlationId)) event.correlationId = input.correlationId;
  if (STAGES.has(input.stage)) event.stage = input.stage;
  if (input.provider === "twilio") event.provider = "twilio";
  if (ERROR_CODES.has(input.errorCode)) event.errorCode = input.errorCode;
  if (DECISIONS.has(input.decision)) event.decision = input.decision;
  if (["phone", "source", "global"].includes(input.restrictionScope)) event.restrictionScope = input.restrictionScope;
  if (isOtpIsoTime(input.retryAt)) event.retryAt = input.retryAt;
  if (Number.isInteger(input.retryAfterSeconds) && input.retryAfterSeconds > 0 && input.retryAfterSeconds <= 86400) event.retryAfterSeconds = input.retryAfterSeconds;
  if (!Object.keys(event).length) return;
  try { console.info("OTP flow", event); } catch { /* Logging cannot change the outcome. */ }
}
