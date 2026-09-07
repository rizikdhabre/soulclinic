const MAX_RETRY_MS = 3_600_000;
const SOURCE_LIMIT_CODES = new Set([
  "OTP_SOURCE_RATE_LIMITED",
  "OTP_FALLBACK_SOURCE_RATE_LIMITED",
]);

export function getRetryDeadline(value, now = Date.now()) {
  const absolute = typeof value?.retryAt === "string" ? Date.parse(value.retryAt) : NaN;
  if (Number.isFinite(absolute)) {
    const serverTime = typeof value?.serverTime === "string" ? Date.parse(value.serverTime) : NaN;
    if (Number.isFinite(serverTime)) {
      // Translate once at receipt; subsequent ticks use the stored local deadline.
      return now + Math.max(0, Math.min(absolute - serverTime, MAX_RETRY_MS));
    }
    return Math.max(0, Math.min(absolute, now + MAX_RETRY_MS));
  }
  const seconds = value?.retryAfterSeconds;
  return Number.isFinite(seconds) && seconds > 0
    ? now + Math.min(Math.ceil(seconds) * 1000, MAX_RETRY_MS)
    : 0;
}

export function getRestrictionScope(code) {
  return SOURCE_LIMIT_CODES.has(code) ? "source" : "phone";
}
