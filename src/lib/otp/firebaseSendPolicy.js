// Shared wire enum: keep this module SDK-free for both browser and server callers.
// Auth names checked against Firebase 12.19.0 / @firebase/auth 1.13.6 AuthErrorCodes.
// UNKNOWN and the observed code 39 are backend passthroughs, not AuthErrorCodes members.
export const FIREBASE_FAILURE_CODES = Object.freeze([
  "auth/network-request-failed", "auth/unknown", "auth/timeout", "auth/internal-error",
  "auth/error-code:-39",
  "auth/invalid-phone-number", "auth/missing-phone-number", "auth/invalid-verification-code",
  "auth/missing-verification-code", "auth/code-expired", "auth/invalid-verification-id",
  "auth/missing-verification-id", "auth/user-disabled", "auth/rejected-credential",
  "auth/captcha-check-failed", "auth/invalid-app-credential", "auth/missing-app-credential",
  "auth/missing-recaptcha-token", "auth/invalid-recaptcha-token", "auth/invalid-recaptcha-action",
  "auth/too-many-requests", "auth/quota-exceeded", "auth/unauthorized-domain",
  "auth/invalid-api-key", "auth/operation-not-allowed", "auth/app-not-authorized",
  "auth/auth-domain-config-required", "auth/recaptcha-not-enabled", "auth/invalid-app-id",
  "auth/argument-error", "auth/already-initialized", "auth/operation-not-supported-in-this-environment",
  "auth/missing-client-type", "auth/missing-recaptcha-version", "auth/invalid-recaptcha-version",
  "auth/invalid-req-type", "auth/user-token-expired", "auth/invalid-user-token",
  "recaptcha/network-request-failed", "recaptcha/timeout",
  "client/browser-required", "client/configuration", "client/container-unavailable",
  "client/container-busy", "client/send-in-progress", "client/cancelled",
  "client/operation-pending", "client/invalid-confirmation", "client/invalid-proof",
  "client/unclassified",
  "client/module-load-failed", "client/sms-not-received", "server/firebase-verification-unavailable",
]);

export const FIREBASE_FAILURE_STAGES = Object.freeze([
  "initialize", "recaptcha_init", "recaptcha_render", "recaptcha_token",
  "send", "confirm", "token", "lifecycle", "logout", "delivery", "server_verify",
]);
export const FIREBASE_FAILURE_PROVENANCES = Object.freeze(["firebase_sdk", "recaptcha_sdk", "client", "server"]);

const codes = new Set(FIREBASE_FAILURE_CODES);
const recaptchaStages = new Set(["recaptcha_init", "recaptcha_render", "recaptcha_token"]);
const technicalCodes = new Set(["auth/internal-error", "auth/network-request-failed", "auth/timeout"]);

// Call only around a rejected dynamic import, never around a provider operation.
export function isFirebaseModuleLoadError(error) {
  if (error?.code != null) return false;
  if (error?.name === "ChunkLoadError" || error?.name === "NetworkError") return true;
  return error?.name === "TypeError" && typeof error.message === "string" &&
    /^(Failed to fetch dynamically imported module|Importing a module script failed|error loading dynamically imported module)/i.test(error.message);
}

export function classifyFirebaseSendFailure(report) {
  if (!report || typeof report !== "object" || Array.isArray(report) ||
      Object.keys(report).length !== 3 ||
      !["code", "stage", "provenance"].every((key) => Object.hasOwn(report, key)) ||
      !codes.has(report.code) || !FIREBASE_FAILURE_STAGES.includes(report.stage) ||
      !FIREBASE_FAILURE_PROVENANCES.includes(report.provenance)) {
    return { eligible: false, ambiguous: false, reason: "invalid_report" };
  }
  const { code, stage, provenance } = report;
  if (code === "client/operation-pending") {
    return { eligible: false, ambiguous: true, reason: "operation_pending" };
  }
  if (code === "client/module-load-failed" && stage === "initialize" && provenance === "client") {
    return { eligible: true, ambiguous: false, reason: "module_load_technical_failure" };
  }
  if (code === "client/sms-not-received" && stage === "delivery" && provenance === "client") {
    return { eligible: true, ambiguous: true, reason: "user_reported_non_receipt" };
  }
  if (code === "server/firebase-verification-unavailable" && stage === "server_verify" && provenance === "server") {
    // The server must independently find its own settled infrastructure failure.
    return { eligible: true, ambiguous: false, reason: "server_verification_technical_failure" };
  }
  if (technicalCodes.has(code) && provenance === "firebase_sdk") {
    if (stage === "initialize" || recaptchaStages.has(stage)) {
      return { eligible: true, ambiguous: false, reason: "sdk_setup_technical_failure" };
    }
    if (stage === "confirm" || stage === "token") {
      return { eligible: true, ambiguous: true, reason: "sdk_verification_technical_failure" };
    }
  }
  if (stage === "send" && provenance === "firebase_sdk" && code === "auth/error-code:-39") {
    // Explicit owner-approved exception; not a diagnosis of code 39 or permission for all 503s.
    // Only a settled rejection qualifies. Existing paid budgets and one-use transfer still apply.
    return { eligible: true, ambiguous: true, reason: "approved_code_39_send_rejection" };
  }
  if (stage === "send" && provenance === "firebase_sdk" &&
      (technicalCodes.has(code) || code === "auth/unknown")) {
    // An SDK rejection is not proof of non-delivery. A live local watchdog is never this path.
    return { eligible: true, ambiguous: true, reason: "sdk_send_rejected_ambiguous" };
  }
  if (recaptchaStages.has(stage) && provenance === "recaptcha_sdk" &&
      (code === "recaptcha/network-request-failed" || code === "recaptcha/timeout")) {
    return { eligible: true, ambiguous: false, reason: "recaptcha_technical_failure" };
  }
  // recaptcha-not-enabled describes project configuration, not a failed script load.
  // captcha-check-failed and invalid-app-credential can be abuse/security rejections;
  // neither proves a technical failure, even when reported from a verifier stage.
  // Unknown future, billing, configuration, quota and verification failures fail closed.
  return { eligible: false, ambiguous: false, reason: "not_eligible" };
}
