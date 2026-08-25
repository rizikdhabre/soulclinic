import { OtpError } from "./errors";

const OTP_PURPOSES = new Set(["booking", "login"]);
const OTP_PROVIDERS = new Set(["firebase", "development", "twilio"]);

export const OTP_CHALLENGE_TTL_MS = 600_000;
export const OTP_STATE_RETENTION_MS = 7_200_000;
export const OTP_COMPLETION_LEASE_MS = 30_000;
export const OTP_GRANT_TTL_MS = 600_000;
export const FIREBASE_CLOCK_SKEW_MS = 120_000;
export const OTP_STATE_CAS_MAX_ATTEMPTS = 8;
export const OTP_PHONE_START_COOLDOWN_MS = 60_000;
export const OTP_PHONE_START_WINDOW_MS = 3_600_000;
export const OTP_PHONE_START_WINDOW_LIMIT = 5;
export const OTP_PHONE_VERIFY_WINDOW_MS = 600_000;
export const OTP_PHONE_VERIFY_FAILURE_LIMIT = 5;
export const OTP_SOURCE_SHORT_WINDOW_MS = 600_000;
export const OTP_SOURCE_HOUR_WINDOW_MS = 3_600_000;
export const OTP_SOURCE_CHALLENGE_SHORT_LIMIT = 10;
export const OTP_SOURCE_CHALLENGE_HOUR_LIMIT = 30;
export const OTP_SOURCE_FALLBACK_SHORT_LIMIT = 3;
export const OTP_SOURCE_FALLBACK_HOUR_LIMIT = 10;

export function assertOtpPurpose(value) {
  if (!OTP_PURPOSES.has(value)) {
    throw new OtpError("INVALID_OTP_PURPOSE", 400, "Invalid OTP purpose.");
  }

  return value;
}

export function selectInitialOtpProvider(env = process.env) {
  const configuredCode = typeof env?.OTP_DEV_CODE === "string" ? env.OTP_DEV_CODE.trim() : "";

  if (env?.NODE_ENV !== "production" && configuredCode) {
    return OTP_PROVIDERS.has("development") ? "development" : "firebase";
  }

  return "firebase";
}
