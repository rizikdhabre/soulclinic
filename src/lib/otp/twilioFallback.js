import { hashBearerToken } from "./crypto";
import { OtpError, attachOtpAttemptMetadata, otpPersistence } from "./errors";
import { OTP_PHONE_START_COOLDOWN_MS } from "./constants";
import { logOtpEvent } from "./diagnostics";
import { isServerApprovedFallbackCode } from "./firebaseErrors";
import { getOtpChallengeStore } from "./challengeStore";
import { createOtpRateLimitStore } from "./rateLimitStore";
import { deriveOtpSourceHash } from "./sourceIdentity";
import {
  classifyTwilioSendError,
  sendTwilioVerification,
} from "@/lib/twilioOTP";

const TERMINAL_SEND_STATUSES = new Set([
  "approved",
  "canceled",
  "deleted",
  "expired",
  "failed",
  "max_attempts_reached",
]);
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

function fallbackError(code, status, message) {
  return new OtpError(code, status, message);
}

function invalidChallenge(expired = false) {
  return fallbackError(
    expired ? "OTP_CHALLENGE_EXPIRED" : "OTP_CHALLENGE_FAILED",
    400,
    "Invalid or expired OTP challenge.",
  );
}

function fallbackAlreadyUsed() {
  return fallbackError(
    "OTP_FALLBACK_ALREADY_USED",
    409,
    "OTP fallback has already been requested.",
  );
}

function fallbackNotAllowed() {
  return fallbackError(
    "OTP_FALLBACK_NOT_ALLOWED",
    400,
    "OTP fallback is not available for this request.",
  );
}

function publicSendFailure(classification) {
  if (classification?.unknown) {
    return {
      code: "OTP_SEND_PENDING",
      status: 503,
      message: "The verification request may still be processing.",
      challengeStatus: "delivery_unknown",
      providerStatus: "unknown",
    };
  }

  if (classification?.errorCode === "OTP_SERVICE_NOT_CONFIGURED") {
    return {
      code: "OTP_SERVICE_NOT_CONFIGURED",
      status: 503,
      message: "OTP service is not configured.",
      challengeStatus: "failed",
      providerStatus: "failed",
    };
  }

  if (["AUTH", "PROVIDER_RATE_LIMIT", "PROVIDER_VALIDATION", "PROVIDER_PERMANENT"].includes(classification?.errorCategory)) {
    return {
      code: "OTP_PROVIDER_REJECTED",
      status: 503,
      message: "The OTP provider rejected the request.",
      challengeStatus: "failed",
      providerStatus: "failed",
    };
  }

  return {
    code: "OTP_SEND_FAILED",
    status: 503,
    message: "Failed to send OTP.",
    challengeStatus: "failed",
    providerStatus: "failed",
  };
}

function resolvedSendFailure(providerStatus) {
  if (TERMINAL_SEND_STATUSES.has(providerStatus)) {
    return {
      code: "OTP_SEND_FAILED",
      status: 503,
      message: "Failed to send OTP.",
      challengeStatus: "failed",
      providerStatus,
    };
  }

  return {
    code: "OTP_SEND_PENDING",
    status: 503,
    message: "The verification request may still be processing.",
    challengeStatus: "delivery_unknown",
    providerStatus: "unknown",
  };
}

export async function requestTwilioFallback(input, deps = {}) {
  const clock = deps.clock ?? systemClock;
  let challenge;
  let phoneRetryAt;
  try {
    if (typeof input?.challengeToken !== "string" || !input.challengeToken) throw invalidChallenge();
    const challengeTokenHash = (deps.hashToken ?? hashBearerToken)(input.challengeToken);
    const challengeStore = deps.challengeStore ?? (await otpPersistence(() => getOtpChallengeStore()));
    challenge = await otpPersistence(() => challengeStore.findByTokenHash(challengeTokenHash));
    const lookupNow = new Date(clock.now());
    phoneRetryAt = challenge?.retryAt ?? (
      challenge?.createdAt instanceof Date
        ? new Date(challenge.createdAt.getTime() + OTP_PHONE_START_COOLDOWN_MS)
        : undefined
    );
    logOtpEvent({ correlationId: challenge?.correlationId, stage: "fallback", decision: "started" });
    if (!challenge || !(challenge.expiresAt instanceof Date)) throw invalidChallenge();
    if (challenge.expiresAt <= lookupNow) throw invalidChallenge(true);

    const env = deps.env ?? process.env;
    const deriveSourceHash = deps.deriveSourceHash ?? deriveOtpSourceHash;
    const sourceHash = await deriveSourceHash(input.request, { env });
    const rateStore = deps.rateStore ?? (await otpPersistence(() => getProductionRateStore(env, clock)));
    await otpPersistence(() => rateStore.claimSourceAction(sourceHash, "fallback"));

    if (challenge.fallbackUsed === true) throw fallbackAlreadyUsed();
    if (challenge.provider !== "firebase" || challenge.status !== "pending") throw fallbackNotAllowed();
    const isApprovedFallbackCode = deps.isApprovedFallbackCode ?? isServerApprovedFallbackCode;
    if (!isApprovedFallbackCode(input.firebaseErrorCode)) {
      logOtpEvent({ correlationId: challenge.correlationId, stage: "firebase_send", provider: "firebase", errorCode: input.firebaseErrorCode, decision: "reject" });
      throw fallbackNotAllowed();
    }
    logOtpEvent({ correlationId: challenge.correlationId, stage: "firebase_send", provider: "firebase", errorCode: input.firebaseErrorCode, decision: "fallback" });

    const reserved = await otpPersistence(() => challengeStore.reserveFallback({
      challengeId: challenge._id, challengeTokenHash,
      firebaseErrorCode: input.firebaseErrorCode, now: new Date(clock.now()),
    }));
    if (!reserved) {
      const fresh = await otpPersistence(() => challengeStore.findByTokenHash(challengeTokenHash));
      if (!fresh || !(fresh.expiresAt instanceof Date)) throw invalidChallenge();
      if (fresh.expiresAt <= new Date(clock.now())) throw invalidChallenge(true);
      if (fresh.fallbackUsed === true) throw fallbackAlreadyUsed();
      throw fallbackNotAllowed();
    }
    logOtpEvent({ correlationId: challenge.correlationId, stage: "fallback", provider: "twilio", decision: "reserved" });

    async function rejectChangedChallenge() {
      const fresh = await otpPersistence(() => challengeStore.findByTokenHash(challengeTokenHash));
      if (!fresh || !(fresh.expiresAt instanceof Date)) throw invalidChallenge();
      if (fresh.expiresAt <= new Date(clock.now())) throw invalidChallenge(true);
      if (fresh.provider !== "twilio" || fresh.status !== "twilio_sending" || fresh.fallbackUsed !== true) {
        throw fallbackNotAllowed();
      }
      throw fallbackError("OTP_STATE_BUSY", 503, "OTP security state is busy.");
    }

    async function recordFailure(failure) {
      logOtpEvent({ correlationId: challenge.correlationId, stage: "twilio", provider: "twilio", decision: "failed", errorCode: failure.code });
      const saved = await otpPersistence(() => challengeStore.markTwilioFailure({
        challengeId: challenge._id, challengeTokenHash,
        status: failure.challengeStatus, providerAttemptCount: 1,
        lastProviderStatus: failure.providerStatus, lastProviderErrorCode: failure.code,
        now: new Date(clock.now()),
      }));
      if (!saved) await rejectChangedChallenge();
      throw fallbackError(failure.code, failure.status, failure.message);
    }

    // One logical reservation permits one provider invocation, never an automatic resend.
    const sendVerification = deps.sendVerification ?? sendTwilioVerification;
    const classifySendError = deps.classifySendError ?? classifyTwilioSendError;
    logOtpEvent({ correlationId: challenge.correlationId, stage: "twilio", provider: "twilio", decision: "started" });
    let verification;
    try {
      verification = await sendVerification(challenge.phone);
    } catch (error) {
      await recordFailure(publicSendFailure(classifySendError(error)));
    }

    const providerStatus = verification?.status;
    if (providerStatus !== "pending") await recordFailure(resolvedSendFailure(providerStatus));
    logOtpEvent({ correlationId: challenge.correlationId, stage: "twilio", provider: "twilio", decision: "success" });
    const sent = await otpPersistence(() => challengeStore.markTwilioSent({
      challengeId: challenge._id, challengeTokenHash, providerAttemptCount: 1,
      lastProviderStatus: providerStatus, now: new Date(clock.now()),
    }));
    if (!sent) await rejectChangedChallenge();
    logOtpEvent({ correlationId: challenge.correlationId, stage: "fallback", provider: "twilio", decision: "success" });
    return { provider: "twilio", status: providerStatus };
  } catch (error) {
    const failure = attachOtpAttemptMetadata(
      error instanceof OtpError ? error : fallbackError("OTP_FALLBACK_FAILED", 500, "Failed to request OTP fallback."),
      { correlationId: challenge?.correlationId, phoneRetryAt, now: new Date(clock.now()) },
    );
    logOtpEvent({ ...failure, errorCode: failure.code, stage: "fallback", provider: "twilio", decision: failure.status === 429 ? "blocked" : "failed" });
    throw failure;
  }
}
