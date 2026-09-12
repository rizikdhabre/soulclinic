const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ISO_UTC_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const STAGES = new Set(["challenge", "send", "verify", "complete", "configuration", "challenge_admission", "firebase_init", "firebase_sdk_load", "firebase_auth_init", "recaptcha_init", "recaptcha_render", "recaptcha_token", "firebase_recaptcha_init", "firebase_recaptcha_token", "firebase_send_started", "firebase_send_accepted", "firebase_send_rejected", "firebase_send_unknown", "fallback_decision", "twilio_fallback_reserved", "twilio_send_accepted", "twilio_send_rejected", "twilio_send_unknown", "firebase_code_confirm", "firebase_id_token_ready", "firebase_server_evidence_checked", "twilio_code_check", "provider_approved", "application_session_issued", "booking_grant_issued", "completion_response"]);
const DECISIONS = new Set(["started", "reserved", "success", "failed", "blocked", "reject", "recovered"]);
const REASONS = new Set(["invalid_report", "operation_pending", "sdk_send_rejected_ambiguous", "recaptcha_technical_failure", "not_eligible", "client_reported", "certificate_fetch_failure"]);
for (const stage of ["firebase_admin_sdk_load", "firebase_admin_init", "firebase_admin_verify"]) STAGES.add(stage);
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
  "auth/internal-error", "auth/captcha-check-failed", "auth/invalid-app-credential", "auth/missing-app-credential",
  "auth/recaptcha-not-enabled", "auth/missing-recaptcha-token", "auth/invalid-recaptcha-token", "auth/invalid-recaptcha-action",
  "auth/missing-client-type", "auth/missing-recaptcha-version", "auth/invalid-recaptcha-version", "auth/invalid-req-type",
  "auth/network-request-failed", "auth/unknown", "auth/too-many-requests", "auth/invalid-phone-number", "auth/missing-phone-number",
  "auth/invalid-verification-code", "auth/code-expired", "auth/session-expired", "auth/unauthorized-domain", "auth/invalid-api-key",
  "auth/operation-not-allowed", "auth/quota-exceeded", "auth/user-disabled", "OTP_EVIDENCE_REQUIRED",
  "auth/argument-error", "auth/invalid-argument", "auth/invalid-id-token", "auth/id-token-expired", "auth/id-token-revoked",
  "auth/user-not-found", "auth/tenant-id-mismatch", "auth/invalid-credential", "auth/insufficient-permission",
  "auth/project-not-found", "auth/invalid-config", "app/invalid-credential", "app/invalid-app-options",
  "app/network-error", "app/network-timeout", "ERR_MODULE_NOT_FOUND", "MODULE_NOT_FOUND", "ERR_REQUIRE_ESM",
  "ERR_INVALID_ARG_TYPE", "ERR_OSSL_UNSUPPORTED", "ENOTFOUND", "EAI_AGAIN", "ECONNRESET", "ECONNREFUSED",
  "ETIMEDOUT", "ECONNABORTED", "EHOSTUNREACH", "ENETUNREACH", "EPIPE", "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_HEADERS_TIMEOUT", "UND_ERR_SOCKET", "admin/type-error", "admin/unclassified",
]);

export function isOtpCorrelationId(value) {
  return typeof value === "string" && UUID_PATTERN.test(value);
}
export function isOtpIsoTime(value) {
  return typeof value === "string" && ISO_UTC_PATTERN.test(value) &&
    Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
}

// Capture the failing Admin boundary before its public error is sanitized.
export function logFirebaseAdminEvent({ correlationId, stage, decision, error } = {}) {
  if (!isOtpCorrelationId(correlationId)) return;
  const event = { correlationId, stage, decision, provider: "firebase" };
  if (error) {
    event.errorCode = ERROR_CODES.has(error.code) ? error.code : error.name === "TypeError" ? "admin/type-error" : "admin/unclassified";
    const message = typeof error.message === "string" ? error.message.slice(0, 300) : "";
    if (["auth/argument-error", "auth/invalid-argument"].includes(error.code) &&
        ["Error fetching public keys", "Error fetching Json Web Keys"].some(prefix => message.startsWith(prefix))) {
      event.reason = "certificate_fetch_failure";
    }
  }
  logOtpEvent(event);
}

// Never project phone numbers, provider payloads, tokens, receipts, or raw errors.
export function logOtpEvent(input = {}) {
  const event = {};
  const environment = input.environment ?? (typeof window === "undefined" ? process.env.VERCEL_ENV : undefined);
  const deploymentSha = input.deploymentSha ?? (typeof window === "undefined" ? process.env.VERCEL_GIT_COMMIT_SHA : undefined);
  if (isOtpCorrelationId(input.correlationId)) event.correlationId = input.correlationId;
  if (STAGES.has(input.stage)) event.stage = input.stage;
  if (["twilio", "firebase"].includes(input.provider)) event.provider = input.provider;
  if (["login", "booking"].includes(input.purpose)) event.purpose = input.purpose;
  if (["production", "preview", "development", "test"].includes(environment)) event.environment = environment;
  if (typeof deploymentSha === "string" && /^[0-9a-f]{40}$/.test(deploymentSha)) event.deploymentSha = deploymentSha;
  if (REASONS.has(input.reason)) event.reason = input.reason;
  if (Number.isSafeInteger(input.elapsedMs) && input.elapsedMs >= 0 && input.elapsedMs <= 3600000) event.elapsedMs = input.elapsedMs;
  if (ERROR_CODES.has(input.errorCode)) event.errorCode = input.errorCode;
  if (DECISIONS.has(input.decision)) event.decision = input.decision;
  if (["phone", "source", "global"].includes(input.restrictionScope)) event.restrictionScope = input.restrictionScope;
  if (isOtpIsoTime(input.retryAt)) event.retryAt = input.retryAt;
  if (Number.isInteger(input.retryAfterSeconds) && input.retryAfterSeconds > 0 && input.retryAfterSeconds <= 86400) event.retryAfterSeconds = input.retryAfterSeconds;
  if (!Object.keys(event).length) return;
  try { console.info("OTP flow", event); } catch { /* Logging cannot change the outcome. */ }
}
