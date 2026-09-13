import {
  FIREBASE_FAILURE_CODES, FIREBASE_FAILURE_STAGES, FIREBASE_FAILURE_PROVENANCES,
  classifyFirebaseSendFailure,
} from "./firebaseSendPolicy";

export const FIREBASE_DIAGNOSTIC_BOUNDARIES = Object.freeze([
  "firebase_client_load", "firebase_sdk_load", "firebase_auth_init", "recaptcha_init",
  "recaptcha_render", "recaptcha_token", "firebase_send", "firebase_confirm", "firebase_token",
]);
export const FIREBASE_ERROR_TYPES = Object.freeze([
  "Error", "TypeError", "ReferenceError", "SyntaxError", "RangeError", "FirebaseError",
  "ChunkLoadError", "AbortError", "NetworkError", "TimeoutError", "unknown",
]);
export const FIREBASE_FAILURE_CATEGORIES = Object.freeze([
  "invalid_phone", "invalid_code", "expired_code", "verification_state", "provider_throttle", "quota_or_billing",
  "configuration", "app_verification", "security_rejection", "technical_send", "technical_recaptcha",
  "technical_setup", "verification_technical", "client_lifecycle", "pending", "unclassified",
]);
export const FIREBASE_FALLBACK_REASONS = Object.freeze([
  "invalid_report", "operation_pending", "sdk_send_rejected_ambiguous", "recaptcha_technical_failure", "not_eligible",
]);

const codes = new Set(FIREBASE_FAILURE_CODES);
const inCodes = (code, values) => values.includes(code);

// Diagnostic hints are independent of the three-field fallback authorization report.
export function projectFirebaseDiagnostic(value) {
  const result = {};
  if (FIREBASE_DIAGNOSTIC_BOUNDARIES.includes(value?.boundary)) result.boundary = value.boundary;
  if (FIREBASE_ERROR_TYPES.includes(value?.errorType)) result.errorType = value.errorType;
  return result;
}

export function firebaseErrorDiagnostic(error, boundary) {
  return projectFirebaseDiagnostic({ boundary, errorType: FIREBASE_ERROR_TYPES.includes(error?.name) ? error.name : "unknown" });
}

function category(code, stage, decision) {
  if (decision.eligible) return decision.reason === "recaptcha_technical_failure" ? "technical_recaptcha" : "technical_send";
  if (code === "client/operation-pending") return "pending";
  if (inCodes(code, ["auth/invalid-phone-number", "auth/missing-phone-number"])) return "invalid_phone";
  if (inCodes(code, ["auth/invalid-verification-code", "auth/missing-verification-code"])) return "invalid_code";
  if (code === "auth/code-expired") return "expired_code";
  if (inCodes(code, ["auth/invalid-verification-id", "auth/missing-verification-id", "auth/user-token-expired"])) return "verification_state";
  if (code === "auth/too-many-requests") return "provider_throttle";
  if (code === "auth/quota-exceeded") return "quota_or_billing";
  if (inCodes(code, ["client/configuration", "auth/unauthorized-domain", "auth/invalid-api-key", "auth/operation-not-allowed",
    "auth/app-not-authorized", "auth/auth-domain-config-required", "auth/recaptcha-not-enabled", "auth/invalid-app-id",
    "auth/missing-client-type", "auth/missing-recaptcha-version", "auth/invalid-recaptcha-version", "auth/invalid-req-type"])) return "configuration";
  if (inCodes(code, ["auth/captcha-check-failed", "auth/invalid-app-credential", "auth/missing-app-credential",
    "auth/missing-recaptcha-token", "auth/invalid-recaptcha-token", "auth/invalid-recaptcha-action"])) return "app_verification";
  if (inCodes(code, ["auth/user-disabled", "auth/rejected-credential", "auth/invalid-user-token"])) return "security_rejection";
  if (inCodes(code, ["auth/network-request-failed", "auth/internal-error", "auth/timeout", "auth/unknown"])) {
    if (stage === "confirm" || stage === "token") return "verification_technical";
    if (stage === "initialize" || stage.startsWith("recaptcha_")) return "technical_setup";
  }
  if (code.startsWith("client/") && code !== "client/unclassified") return "client_lifecycle";
  return "unclassified";
}

export function firebaseFailureDetails(report, diagnostic) {
  const decision = classifyFirebaseSendFailure(report);
  const errorCode = codes.has(report?.code) ? report.code : "client/unclassified";
  const failureStage = FIREBASE_FAILURE_STAGES.includes(report?.stage) ? report.stage : "unknown";
  const failureProvenance = FIREBASE_FAILURE_PROVENANCES.includes(report?.provenance) ? report.provenance : "unknown";
  const hint = projectFirebaseDiagnostic(diagnostic);
  return {
    errorCode, failureStage, failureProvenance,
    failureCategory: category(errorCode, failureStage, decision),
    fallbackDecision: decision.eligible ? "eligible" : "blocked", fallbackReason: decision.reason,
    ...(hint.boundary ? { failureBoundary: hint.boundary } : {}),
    ...(hint.errorType ? { errorType: hint.errorType } : {}),
  };
}
