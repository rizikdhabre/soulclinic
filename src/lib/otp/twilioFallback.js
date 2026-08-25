import { hashBearerToken } from "./crypto";
import { OtpError } from "./errors";
import { isServerApprovedFallbackCode } from "./firebaseErrors";
import { getOtpChallengeStore } from "./challengeStore";
import { createOtpRateLimitStore } from "./rateLimitStore";
import { deriveOtpSourceHash } from "./sourceIdentity";
import {
  classifyTwilioSendError,
  sendTwilioVerification,
} from "@/lib/twilioOTP";

const MAX_SEND_ATTEMPTS = 3;
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

function fallbackError(code, status, message) {
  return new OtpError(code, status, message);
}

function invalidChallenge() {
  return fallbackError(
    "OTP_CHALLENGE_FAILED",
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

function publicSendFailure(classification, finalAttempt) {
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

  if (classification?.retryable && finalAttempt) {
    return {
      code: "OTP_SEND_RETRIES_EXHAUSTED",
      status: 503,
      message: "Failed to send OTP after multiple attempts.",
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
  if (typeof input?.challengeToken !== "string" || !input.challengeToken) {
    throw invalidChallenge();
  }

  const hashToken = deps.hashToken ?? hashBearerToken;
  const challengeTokenHash = hashToken(input.challengeToken);
  const challengeStore = deps.challengeStore ?? (await getOtpChallengeStore());
  const challenge = await challengeStore.findByTokenHash(challengeTokenHash);
  const clock = deps.clock ?? systemClock;
  const lookupNow = new Date(clock.now());

  if (
    !challenge ||
    !(challenge.expiresAt instanceof Date) ||
    challenge.expiresAt <= lookupNow
  ) {
    throw invalidChallenge();
  }

  const env = deps.env ?? process.env;
  const deriveSourceHash = deps.deriveSourceHash ?? deriveOtpSourceHash;
  const sourceHash = await deriveSourceHash(input.request, { env });
  const rateStore = deps.rateStore ?? (await getProductionRateStore());
  await rateStore.claimSourceAction(sourceHash, "fallback");

  if (challenge.fallbackUsed === true) {
    throw fallbackAlreadyUsed();
  }

  if (challenge.provider !== "firebase" || challenge.status !== "pending") {
    throw fallbackNotAllowed();
  }

  const isApprovedFallbackCode =
    deps.isApprovedFallbackCode ?? isServerApprovedFallbackCode;
  if (!isApprovedFallbackCode(input.firebaseErrorCode)) {
    throw fallbackNotAllowed();
  }

  const reserved = await challengeStore.reserveFallback({
    challengeId: challenge._id,
    challengeTokenHash,
    firebaseErrorCode: input.firebaseErrorCode,
    now: new Date(clock.now()),
  });
  if (!reserved) {
    const freshChallenge = await challengeStore.findByTokenHash(
      challengeTokenHash,
    );
    const freshNow = new Date(clock.now());
    if (
      !freshChallenge ||
      !(freshChallenge.expiresAt instanceof Date) ||
      freshChallenge.expiresAt <= freshNow
    ) {
      throw invalidChallenge();
    }
    if (freshChallenge.fallbackUsed === true) {
      throw fallbackAlreadyUsed();
    }
    throw fallbackNotAllowed();
  }

  const sendVerification = deps.sendVerification ?? sendTwilioVerification;
  const classifySendError = deps.classifySendError ?? classifyTwilioSendError;

  for (let attempt = 1; attempt <= MAX_SEND_ATTEMPTS; attempt += 1) {
    let verification;
    try {
      verification = await sendVerification(challenge.phone);
    } catch (error) {
      const classification = classifySendError(error);
      const finalAttempt = attempt === MAX_SEND_ATTEMPTS;
      if (classification?.retryable && !finalAttempt) continue;

      const failure = publicSendFailure(classification, finalAttempt);
      await challengeStore.markTwilioFailure({
        challengeId: challenge._id,
        challengeTokenHash,
        status: failure.challengeStatus,
        providerAttemptCount: attempt,
        lastProviderStatus: failure.providerStatus,
        lastProviderErrorCode: failure.code,
        now: new Date(clock.now()),
      });
      throw fallbackError(failure.code, failure.status, failure.message);
    }

    const providerStatus = verification?.status;
    if (providerStatus !== "pending") {
      const failure = resolvedSendFailure(providerStatus);
      await challengeStore.markTwilioFailure({
        challengeId: challenge._id,
        challengeTokenHash,
        status: failure.challengeStatus,
        providerAttemptCount: attempt,
        lastProviderStatus: failure.providerStatus,
        lastProviderErrorCode: failure.code,
        now: new Date(clock.now()),
      });
      throw fallbackError(failure.code, failure.status, failure.message);
    }

    let sent;
    try {
      sent = await challengeStore.markTwilioSent({
        challengeId: challenge._id,
        challengeTokenHash,
        providerAttemptCount: attempt,
        lastProviderStatus: providerStatus,
        now: new Date(clock.now()),
      });
    } catch {
      throw fallbackError(
        "OTP_SEND_PENDING",
        503,
        "The verification request may still be processing.",
      );
    }

    if (!sent) {
      throw fallbackError(
        "OTP_SEND_PENDING",
        503,
        "The verification request may still be processing.",
      );
    }
    return { provider: "twilio", status: providerStatus };
  }

  throw fallbackError("OTP_SEND_FAILED", 503, "Failed to send OTP.");
}
