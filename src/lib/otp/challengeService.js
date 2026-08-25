import { normalizeIsraeliPhone } from "@/lib/phone";
import {
  OTP_CHALLENGE_TTL_MS,
  assertOtpPurpose,
  selectInitialOtpProvider,
} from "./constants";
import { createBearerToken, hashBearerToken } from "./crypto";
import { OtpError } from "./errors";
import { getOtpChallengeStore } from "./challengeStore";
import { createOtpRateLimitStore } from "./rateLimitStore";
import { deriveOtpSourceHash } from "./sourceIdentity";

const systemClock = { now: () => new Date() };
let productionRateStorePromise;

async function getProductionRateStore() {
  if (!productionRateStorePromise) {
    productionRateStorePromise = import("@/lib/db").then(({ getCollection }) =>
      Promise.all([
        getCollection("otpSecurityState"),
        getCollection("otpSourceSecurityState"),
      ]).then(([phoneCollection, sourceCollection]) =>
        createOtpRateLimitStore({ phoneCollection, sourceCollection }),
      ),
    );
  }
  return productionRateStorePromise;
}

export async function createOtpChallenge(input, deps = {}) {
  const env = deps.env ?? process.env;
  const request = input?.request;
  const deriveSourceHash = deps.deriveSourceHash ?? deriveOtpSourceHash;
  const sourceHash = await deriveSourceHash(request, { env });

  const rateStore = deps.rateStore ?? (await getProductionRateStore());
  await rateStore.claimSourceAction(sourceHash, "challenge");

  const phone = normalizeIsraeliPhone(input?.phone);
  if (!phone) {
    throw new OtpError("INVALID_PHONE", 400, "Invalid phone number.");
  }
  const purpose = assertOtpPurpose(input?.purpose);

  const phoneClaim = await rateStore.claimPhoneStart(phone);
  const tokenFactory = deps.tokenFactory ?? createBearerToken;
  const hashToken = deps.hashToken ?? hashBearerToken;
  const challengeToken = tokenFactory();
  const challengeTokenHash = hashToken(challengeToken);
  const provider = selectInitialOtpProvider(env);
  const clock = deps.clock ?? systemClock;
  const now = new Date(clock.now());
  const expiresAt = new Date(now.getTime() + OTP_CHALLENGE_TTL_MS);
  const challengeStore = deps.challengeStore ?? (await getOtpChallengeStore());

  const challenge = await challengeStore.rotate({
    phone,
    purpose,
    challengeTokenHash,
    provider,
    now,
    expiresAt,
  });
  if (!challenge) {
    throw new OtpError("OTP_CHALLENGE_FAILED", 500, "Failed to create OTP challenge.");
  }

  return {
    challengeToken,
    provider,
    expiresAt,
    retryAfterSeconds: phoneClaim?.retryAfterSeconds,
  };
}

export function createOtpChallengeService(deps = {}) {
  return {
    create(input) {
      return createOtpChallenge(input, deps);
    },
  };
}
