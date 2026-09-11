import { randomUUID } from "node:crypto";
import { normalizeIsraeliPhone } from "@/lib/phone";
import { OTP_CHALLENGE_TTL_MS, OTP_PHONE_START_COOLDOWN_MS, assertOtpPurpose } from "./constants";
import { createBearerToken, hashBearerToken, otpSecretKey } from "./crypto";
import { OtpError, attachOtpAttemptMetadata, otpPersistence, otpRetryMetadata } from "./errors";
import { logOtpEvent } from "./diagnostics";
import { getOtpChallengeStore } from "./challengeStore";
import { getOtpRateStore } from "./stores";
import { deriveOtpSourceHash } from "./sourceIdentity";

export async function createOtpChallenge(input, deps = {}) {
  const env = deps.env ?? process.env;
  const now = () => new Date(deps.clock?.now() ?? Date.now());
  const correlationId = randomUUID();
  let phoneRetryAt;
  let provider = "twilio";
  try {
    const providerPolicy = env.OTP_PROVIDER_MODE ?? "twilio_only";
    if (!["twilio_only", "firebase_first"].includes(providerPolicy)) throw new OtpError("OTP_SERVICE_NOT_CONFIGURED", 503, "Invalid OTP provider mode.");
    provider = providerPolicy === "firebase_first" ? "firebase" : "twilio";
    otpSecretKey("receipt", env);
    const sourceHash = await (deps.deriveSourceHash ?? deriveOtpSourceHash)(input?.request, { env });
    const rateStore = await otpPersistence(() => getOtpRateStore(deps));
    await otpPersistence(() => rateStore.claimSourceAction(sourceHash, "challenge"));
    const phone = normalizeIsraeliPhone(input?.phone);
    if (!phone) throw new OtpError("INVALID_PHONE", 400, "Invalid phone number.");
    const purpose = assertOtpPurpose(input?.purpose);
    const reservation = await otpPersistence(() => rateStore.claimPhoneStart(phone));
    phoneRetryAt = reservation?.retryAt ?? new Date(+now() + OTP_PHONE_START_COOLDOWN_MS).toISOString();
    const challengeToken = createBearerToken();
    const challengeTokenHash = hashBearerToken(challengeToken);
    const createdAt = now();
    const expiresAt = new Date(+createdAt + OTP_CHALLENGE_TTL_MS);
    const store = deps.challengeStore ?? await otpPersistence(() => getOtpChallengeStore());
    await otpPersistence(() => store.create({ phone, purpose, sourceHash, challengeTokenHash, now: createdAt, expiresAt, correlationId, retryAt: new Date(phoneRetryAt), providerPolicy }));
    const serverTime = now();
    logOtpEvent({ correlationId, stage: "challenge_admission", provider, purpose, decision: "success" });
    return { challengeToken, provider, providerPolicy, phone, purpose, expiresAt, correlationId, retryAt: phoneRetryAt,
      serverTime: serverTime.toISOString(), retryAfterSeconds: otpRetryMetadata(phoneRetryAt, serverTime).retryAfterSeconds ?? 0 };
  } catch (error) {
    const failure = attachOtpAttemptMetadata(error instanceof OtpError ? error : new OtpError("OTP_CHALLENGE_FAILED", 503, "Could not prepare verification."), { correlationId, phoneRetryAt, now: now() });
    logOtpEvent({ ...failure, stage: "challenge_admission", provider, errorCode: failure.code, decision: failure.status === 429 ? "blocked" : "failed" });
    throw failure;
  }
}

export function createOtpChallengeService(deps = {}) {
  return { create: (input) => createOtpChallenge(input, deps) };
}
