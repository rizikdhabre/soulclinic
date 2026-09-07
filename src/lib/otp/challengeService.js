import { randomUUID } from "node:crypto";
import { normalizeIsraeliPhone } from "@/lib/phone";
import {
  OTP_CHALLENGE_TTL_MS,
  OTP_PHONE_START_COOLDOWN_MS,
  assertOtpPurpose,
  selectInitialOtpProvider,
} from "./constants";
import { createBearerToken, hashBearerToken } from "./crypto";
import { OtpError, attachOtpAttemptMetadata, otpPersistence, otpRetryMetadata } from "./errors";
import { logOtpEvent } from "./diagnostics";
import { getOtpChallengeStore } from "./challengeStore";
import { createOtpRateLimitStore } from "./rateLimitStore";
import { deriveOtpSourceHash } from "./sourceIdentity";

const systemClock = { now: () => new Date() };
let productionRateStorePromise;

async function getProductionRateStore(env = process.env, clock = systemClock) {
  const create = () => import("@/lib/db").then(({ getCollection }) =>
      Promise.all([
        getCollection("otpSecurityState"),
        getCollection("otpSourceSecurityState"),
      ]).then(([phoneCollection, sourceCollection]) =>
        createOtpRateLimitStore({ phoneCollection, sourceCollection, env, clock }),
      ),
    );
  if (env !== process.env || clock !== systemClock) return create();
  if (!productionRateStorePromise) productionRateStorePromise = create();
  return productionRateStorePromise;
}

export async function createOtpChallenge(input, deps = {}) {
  const env = deps.env ?? process.env;
  const clock = deps.clock ?? systemClock;
  const correlationId = randomUUID();
  let phoneRetryAt;
  logOtpEvent({ correlationId, stage: "challenge", decision: "started" });
  try {
    const deriveSourceHash = deps.deriveSourceHash ?? deriveOtpSourceHash;
    const sourceHash = await deriveSourceHash(input?.request, { env });
    const rateStore = deps.rateStore ?? (await otpPersistence(() => getProductionRateStore(env, clock)));
    await otpPersistence(() => rateStore.claimSourceAction(sourceHash, "challenge"));

    const phone = normalizeIsraeliPhone(input?.phone);
    if (!phone) throw new OtpError("INVALID_PHONE", 400, "Invalid phone number.");
    const purpose = assertOtpPurpose(input?.purpose);
    const claimStartedAt = new Date(clock.now());
    const phoneClaim = await otpPersistence(() => rateStore.claimPhoneStart(phone));
    // Legacy injected stores may only return seconds; real stores supply the CAS deadline.
    phoneRetryAt = phoneClaim?.retryAt ?? new Date(claimStartedAt.getTime() + OTP_PHONE_START_COOLDOWN_MS).toISOString();
    logOtpEvent({ correlationId, stage: "challenge", decision: "reserved", ...otpRetryMetadata(phoneRetryAt, new Date(clock.now())) });

    const challengeToken = (deps.tokenFactory ?? createBearerToken)();
    const challengeTokenHash = (deps.hashToken ?? hashBearerToken)(challengeToken);
    const provider = selectInitialOtpProvider(env);
    const now = new Date(clock.now());
    const expiresAt = new Date(now.getTime() + OTP_CHALLENGE_TTL_MS);
    const challengeStore = deps.challengeStore ?? (await otpPersistence(() => getOtpChallengeStore()));
    const challenge = await otpPersistence(() => challengeStore.rotate({
      phone, purpose, challengeTokenHash, provider, now, expiresAt,
      correlationId, retryAt: new Date(phoneRetryAt),
    }));
    if (!challenge) throw new OtpError("OTP_PERSISTENCE_FAILED", 503, "OTP state could not be saved or read.");

    const responseNow = new Date(clock.now());
    const retry = otpRetryMetadata(phoneRetryAt, responseNow);
    logOtpEvent({ correlationId, stage: "challenge", provider, decision: "success", ...retry });
    return {
      challengeToken, provider, expiresAt, correlationId,
      retryAt: phoneRetryAt,
      serverTime: responseNow.toISOString(),
      retryAfterSeconds: retry.retryAfterSeconds ?? 0,
    };
  } catch (error) {
    const failure = attachOtpAttemptMetadata(
      error instanceof OtpError ? error : new OtpError("OTP_CHALLENGE_FAILED", 500, "Failed to create OTP challenge."),
      { correlationId, phoneRetryAt, now: new Date(clock.now()) },
    );
    logOtpEvent({ ...failure, errorCode: failure.code, stage: "challenge", decision: failure.status === 429 ? "blocked" : "failed" });
    throw failure;
  }
}

export function createOtpChallengeService(deps = {}) {
  return {
    create(input) {
      return createOtpChallenge(input, deps);
    },
  };
}
