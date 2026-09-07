import {
  FIREBASE_RECAPTCHA_SETUP_FAILED,
  FirebaseRecaptchaSetupError,
} from "./firebaseSetupError";

const FALLBACK_CODES = new Set([
  "auth/internal-error",
  // Firebase project quota, not its too-many-requests abuse rejection.
  "auth/quota-exceeded",
  "auth/captcha-check-failed",
  "auth/missing-app-credential",
  "auth/invalid-app-credential",
  "auth/network-request-failed",
  "auth/unknown",
  "auth/recaptcha-not-enabled",
  "auth/missing-recaptcha-token",
  "auth/invalid-recaptcha-token",
  "auth/invalid-recaptcha-action",
  "auth/missing-client-type",
  "auth/missing-recaptcha-version",
  "auth/invalid-recaptcha-version",
  "auth/invalid-req-type",
]);

export function classifyFirebaseSendError(value) {
  if (value instanceof FirebaseRecaptchaSetupError) {
    return { action: "fallback", code: FIREBASE_RECAPTCHA_SETUP_FAILED };
  }

  const hasExplicitCode =
    typeof value === "string" || typeof value?.code === "string";
  const code = typeof value === "string"
    ? value
    : typeof value?.code === "string" ? value.code : "auth/unknown";
  // A copied code or serialized error is not client-side setup provenance.
  if (code === FIREBASE_RECAPTCHA_SETUP_FAILED) {
    return { action: "reject", code: "auth/unknown" };
  }
  if (hasExplicitCode && FALLBACK_CODES.has(code)) {
    return { action: "fallback", code };
  }
  return { action: "reject", code };
}

export function isServerApprovedFallbackCode(code) {
  // This is eligibility only; the server still validates and claims the challenge.
  return code === FIREBASE_RECAPTCHA_SETUP_FAILED || FALLBACK_CODES.has(code);
}
