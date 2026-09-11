import { OtpError } from "./errors";

const OTP_PURPOSES = new Set(["booking", "login"]);

export const OTP_CHALLENGE_TTL_MS = 600_000;
export const OTP_STATE_RETENTION_MS = 7_200_000;
export const OTP_COMPLETION_LEASE_MS = 30_000;
export const OTP_GRANT_TTL_MS = 600_000;
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
export const OTP_SOURCE_SEND_SHORT_LIMIT = 5;
export const OTP_SOURCE_SEND_HOUR_LIMIT = 20;
export const OTP_GLOBAL_SEND_HOUR_WINDOW_MS = 3_600_000;
export const OTP_GLOBAL_SEND_DAY_WINDOW_MS = 86_400_000;
export const OTP_GLOBAL_SEND_HOUR_LIMIT = 50;
export const OTP_GLOBAL_SEND_DAY_LIMIT = 200;
export const OTP_GLOBAL_SEND_RETENTION_MS = OTP_GLOBAL_SEND_DAY_WINDOW_MS + OTP_STATE_RETENTION_MS;

// Every override is finite and bounded; phone and one-use challenge controls
// remain independent. Raise limits only with traffic and spend evidence.
export const OTP_SOURCE_LIMIT_CONFIG = Object.freeze({
  OTP_SOURCE_CHALLENGE_SHORT_LIMIT: { defaultValue: OTP_SOURCE_CHALLENGE_SHORT_LIMIT, max: 30 },
  OTP_SOURCE_CHALLENGE_HOUR_LIMIT: { defaultValue: OTP_SOURCE_CHALLENGE_HOUR_LIMIT, max: 90 },
  OTP_SOURCE_SEND_SHORT_LIMIT: { defaultValue: OTP_SOURCE_SEND_SHORT_LIMIT, max: 20 },
  OTP_SOURCE_SEND_HOUR_LIMIT: { defaultValue: OTP_SOURCE_SEND_HOUR_LIMIT, max: 60 },
});

export const OTP_GLOBAL_SEND_LIMIT_CONFIG = Object.freeze({
  OTP_GLOBAL_SEND_HOUR_LIMIT: { defaultValue: OTP_GLOBAL_SEND_HOUR_LIMIT, max: 200 },
  OTP_GLOBAL_SEND_DAY_LIMIT: { defaultValue: OTP_GLOBAL_SEND_DAY_LIMIT, max: 1000 },
});

export function assertOtpPurpose(value) {
  if (!OTP_PURPOSES.has(value)) {
    throw new OtpError("INVALID_OTP_PURPOSE", 400, "Invalid OTP purpose.");
  }

  return value;
}
