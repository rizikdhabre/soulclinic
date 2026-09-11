// Shared wire enum: keep this module SDK-free for both browser and server callers.
// Auth names checked against Firebase 12.19.0 / @firebase/auth 1.13.6 AuthErrorCodes.
// UNKNOWN is a backend-code passthrough, not an AuthErrorCodes member. Never invent it.
export const FIREBASE_FAILURE_CODES = Object.freeze([
  "auth/network-request-failed", "auth/unknown", "auth/timeout", "auth/internal-error",
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
]);

export const FIREBASE_FAILURE_STAGES = Object.freeze([
  "initialize", "recaptcha_init", "recaptcha_render", "recaptcha_token",
  "send", "confirm", "token", "lifecycle", "logout",
]);
export const FIREBASE_FAILURE_PROVENANCES = Object.freeze(["firebase_sdk", "recaptcha_sdk", "client"]);

const codes = new Set(FIREBASE_FAILURE_CODES);
const recaptchaStages = new Set(["recaptcha_init", "recaptcha_render", "recaptcha_token"]);

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
  if (stage === "send" && provenance === "firebase_sdk" &&
      (code === "auth/internal-error" || code === "auth/network-request-failed" || code === "auth/unknown")) {
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
