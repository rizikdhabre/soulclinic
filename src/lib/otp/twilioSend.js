import { randomUUID } from "node:crypto";
import { hashBearerToken, otpSecretKey } from "./crypto";
import { OtpError, otpPersistence, attachOtpAttemptMetadata } from "./errors";
import { getOtpChallengeStore } from "./challengeStore";
import { getOtpRateStore } from "./stores";
import { deriveOtpSourceHash } from "./sourceIdentity";
import { logOtpEvent } from "./diagnostics";
import { openOtpReceipt, sealOtpReceipt, persistObservedResult } from "./recovery";
import { classifyTwilioSendError, sendTwilioVerification } from "@/lib/twilioOTP";

function sendFailure(code = "OTP_SEND_PENDING", status = 503) {
  return new OtpError(code, status, "The SMS request could not be confirmed.");
}

function savedSend(challenge) {
  if (["sent", "verifying", "approved", "completed"].includes(challenge.status) && /^VE[0-9a-f]{32}$/i.test(challenge.verificationSid)) {
    return { provider: "twilio", status: "pending" };
  }
  if (challenge.status === "failed") throw sendFailure(challenge.sendErrorCode || "OTP_SEND_FAILED", challenge.sendErrorStatus || 503);
  throw sendFailure();
}

export async function requestTwilioSend(input, deps = {}) {
  const env = deps.env ?? process.env;
  const now = () => new Date(deps.clock?.now() ?? Date.now());
  let challenge;
  let receipt;
  try {
    otpSecretKey("receipt", env);
    if (typeof input?.challengeToken !== "string" || !/^[\w-]{43}$/.test(input.challengeToken)) throw sendFailure("OTP_CHALLENGE_FAILED", 400);
    const challengeTokenHash = hashBearerToken(input.challengeToken);
    const store = deps.challengeStore ?? await otpPersistence(() => getOtpChallengeStore());
    challenge = await otpPersistence(() => store.findByTokenHash(challengeTokenHash));
    if (!challenge || challenge.provider !== "twilio") throw sendFailure("OTP_CHALLENGE_FAILED", 400);
    if (!(challenge.expiresAt instanceof Date) || challenge.expiresAt <= now()) throw sendFailure("OTP_CHALLENGE_EXPIRED", 400);
    const sourceHash = await (deps.deriveSourceHash ?? deriveOtpSourceHash)(input.request, { env });
    if (sourceHash !== challenge.sourceHash) throw sendFailure("OTP_CHALLENGE_FAILED", 400);

    async function saveSend(result) {
      return persistObservedResult(store, {
        challengeTokenHash, from: "sending", now: now(),
        match: { sendAttemptId: result.attemptId, expiresAt: { $gt: now() } },
        patch: { status: "sent", verificationSid: result.verificationSid, sentAt: new Date(result.observedAt) },
      }, (value) => ["sent", "verifying", "approved", "completed"].includes(value.status) && value.verificationSid === result.verificationSid && value.sendAttemptId === result.attemptId);
    }

    if (input.recoveryReceipt) {
      const recovered = openOtpReceipt(input.recoveryReceipt, { challenge, operation: "send", now: now(), env });
      receipt = input.recoveryReceipt;
      challenge = await saveSend(recovered);
      logOtpEvent({ correlationId: challenge.correlationId, provider: "twilio", stage: "send", decision: "recovered" });
      return savedSend(challenge);
    }
    if (challenge.status !== "prepared") return savedSend(challenge);

    const sendAttemptId = randomUUID();
    const reserved = await otpPersistence(() => store.transition({
      challengeTokenHash, from: "prepared", now: now(), match: { expiresAt: { $gt: now() } },
      patch: { status: "sending", sendAttemptId },
    }));
    if (!reserved) return savedSend(await otpPersistence(() => store.findByTokenHash(challengeTokenHash)) || challenge);
    challenge = reserved;

    try {
      const rateStore = await otpPersistence(() => getOtpRateStore(deps));
      await otpPersistence(() => rateStore.claimSourceAction(sourceHash, "send"));
      await otpPersistence(() => rateStore.claimGlobalSend());
    } catch (error) {
      challenge = await otpPersistence(() => store.transition({ challengeTokenHash, from: "sending", now: now(), match: { sendAttemptId }, patch: { status: "failed", sendErrorCode: error.code, sendErrorStatus: error.status } })) || challenge;
      throw error;
    }

    logOtpEvent({ correlationId: challenge.correlationId, stage: "send", provider: "twilio", decision: "reserved" });
    let result;
    try {
      result = await (deps.sendVerification ?? sendTwilioVerification)(challenge.phone);
    } catch (error) {
      const failure = classifyTwilioSendError(error);
      const code = failure.unknown ? "OTP_SEND_PENDING" :
        failure.errorCode === "OTP_RATE_LIMITED" ? "OTP_RATE_LIMITED" :
        failure.errorCode === "OTP_SERVICE_NOT_CONFIGURED" ? "OTP_SERVICE_NOT_CONFIGURED" : "OTP_SEND_FAILED";
      const status = code === "OTP_RATE_LIMITED" ? 429 : 503;
      challenge = await otpPersistence(() => store.transition({ challengeTokenHash, from: "sending", now: now(), match: { sendAttemptId }, patch: { status: failure.unknown ? "delivery_unknown" : "failed", sendErrorCode: code, sendErrorStatus: status } })) || challenge;
      throw sendFailure(code, status);
    }

    if (result?.status !== "pending" || !/^VE[0-9a-f]{32}$/i.test(result?.sid) || result?.to !== challenge.phone || result?.channel !== "sms") {
      await otpPersistence(() => store.transition({ challengeTokenHash, from: "sending", now: now(), match: { sendAttemptId }, patch: { status: "delivery_unknown", sendErrorCode: "OTP_SEND_PENDING" } }));
      throw sendFailure();
    }
    const observed = { operation: "send", challengeTokenHash, phone: challenge.phone, purpose: challenge.purpose,
      attemptId: sendAttemptId, verificationSid: result.sid, observedAt: +now(), expiresAt: +challenge.expiresAt };
    receipt = sealOtpReceipt(observed, env);
    challenge = await saveSend(observed);
    logOtpEvent({ correlationId: challenge.correlationId, stage: "send", provider: "twilio", decision: "success" });
    return savedSend(challenge);
  } catch (error) {
    const failure = attachOtpAttemptMetadata(error instanceof OtpError ? error : sendFailure("OTP_SEND_FAILED"), {
      correlationId: challenge?.correlationId, phoneRetryAt: challenge?.retryAt, now: now(),
    });
    if (receipt) failure.recoveryReceipt = receipt;
    if (!receipt && (challenge?.status === "failed" || failure.code === "OTP_CHALLENGE_EXPIRED")) failure.restartAllowed = true;
    logOtpEvent({ ...failure, errorCode: failure.code, stage: "send", provider: "twilio", decision: failure.status === 429 ? "blocked" : "failed" });
    throw failure;
  }
}
