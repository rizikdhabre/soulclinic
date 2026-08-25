const FALLBACK_CODES = new Set([
  "auth/internal-error",
  "auth/operation-not-allowed",
  "auth/app-not-authorized",
  "auth/quota-exceeded",
  "auth/captcha-check-failed",
  "auth/missing-app-credential",
  "auth/invalid-app-credential",
  "auth/network-request-failed",
  "auth/unknown",
]);

export function classifyFirebaseSendError(value) {
  const hasExplicitCode =
    typeof value === "string" || typeof value?.code === "string";
  const code = typeof value === "string" ? value : value?.code || "auth/unknown";
  if (hasExplicitCode && FALLBACK_CODES.has(code)) {
    return { action: "fallback", code };
  }
  return { action: "reject", code };
}

export function isServerApprovedFallbackCode(code) {
  return FALLBACK_CODES.has(code);
}
