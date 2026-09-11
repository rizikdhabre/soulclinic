import { randomUUID } from "node:crypto";
import { issueBookingGrant, OtpVerificationGrantError } from "./bookingGrant";
import { getCustomerSessionTtlSeconds, signCustomerSession } from "@/lib/customerSession";
import { normalizeIsraeliPhone } from "@/lib/phone";
import { OTP_GRANT_TTL_MS, OTP_PHONE_VERIFY_FAILURE_LIMIT } from "./constants";
import { hashBearerToken, deriveBookingToken, otpSecretKey } from "./crypto";
import { OtpError, otpPersistence, attachOtpAttemptMetadata } from "./errors";
import { getOtpChallengeStore } from "./challengeStore";
import { getOtpRateStore } from "./stores";
import { logOtpEvent } from "./diagnostics";
import { openOtpReceipt, sealOtpReceipt, persistObservedResult } from "./recovery";
import { classifyTwilioVerifyError, verifyTwilioCode } from "@/lib/twilioOTP";

function failure(code = "OTP_COMPLETION_FAILED", status = 503) {
  return new OtpError(code, status, "Phone verification could not be completed.");
}
const validDate = (value) => value instanceof Date && Number.isFinite(+value);
const approved = (value) => ["approved", "completed"].includes(value?.status) && validDate(value.approvedAt);

async function readProfile(phone, deps) {
  const collection = deps.usersData ?? await (await import("@/lib/db")).getCollection("usersData");
  const value = await collection.findOne({ phone }, { projection: { firstName: 1, lastName: 1 } });
  const firstName = typeof value?.firstName === "string" ? value.firstName.trim() : "";
  const lastName = typeof value?.lastName === "string" ? value.lastName.trim() : "";
  return firstName && lastName ? { hasCompleteName: true, firstName, lastName } : { hasCompleteName: false };
}

export async function completeOtpChallenge(payload, deps = {}) {
  const env = deps.env ?? process.env;
  const now = () => new Date(deps.clock?.now() ?? Date.now());
  let challenge;
  let receipt;
  try {
    otpSecretKey("receipt", env);
    if (typeof payload?.challengeToken !== "string" || !/^[\w-]{43}$/.test(payload.challengeToken)) throw failure("OTP_CHALLENGE_TOKEN_REQUIRED", 400);
    const challengeTokenHash = hashBearerToken(payload.challengeToken);
    const store = deps.challengeStore ?? await otpPersistence(() => getOtpChallengeStore());
    challenge = await otpPersistence(() => store.findByTokenHash(challengeTokenHash));
    if (!challenge?._id || challenge.provider !== "twilio" || !["login", "booking"].includes(challenge.purpose) || typeof challenge.phone !== "string" || normalizeIsraeliPhone(challenge.phone) !== challenge.phone || !validDate(challenge.expiresAt)) throw failure("OTP_VERIFICATION_INVALID", 401);
    if (payload.purpose !== challenge.purpose) throw failure("OTP_PURPOSE_MISMATCH", 400);

    async function saveApproval(result) {
      return persistObservedResult(store, {
        challengeTokenHash, from: "verifying", now: now(),
        match: { verifyAttemptId: result.attemptId, verificationSid: result.verificationSid },
        patch: { status: "approved", approvedAt: new Date(result.observedAt), completionExpiresAt: new Date(result.expiresAt), sessionTtlSeconds: result.sessionTtlSeconds },
      }, (value) => approved(value) && value.verifyAttemptId === result.attemptId && value.verificationSid === result.verificationSid);
    }

    if (payload.recoveryReceipt) {
      const observed = openOtpReceipt(payload.recoveryReceipt, { challenge, operation: "verify", now: now(), env });
      receipt = payload.recoveryReceipt;
      challenge = await saveApproval(observed);
      logOtpEvent({ correlationId: challenge.correlationId, stage: "verify", provider: "twilio", decision: "recovered" });
    }

    if (!approved(challenge)) {
      if (challenge.expiresAt <= now()) throw failure("OTP_VERIFICATION_EXPIRED", 401);
      if (challenge.status === "verifying") throw failure("OTP_COMPLETION_IN_PROGRESS", 409);
      if (challenge.status === "verify_unknown") throw failure("OTP_VERIFY_TEMPORARY_FAILURE");
      if (challenge.status !== "sent") throw failure("OTP_VERIFICATION_INVALID", 401);
      if (typeof payload.code !== "string" || !/^\d{4,10}$/.test(payload.code)) throw failure("INVALID_OTP", 401);
      const sessionTtlSeconds = challenge.purpose === "login" ? getCustomerSessionTtlSeconds({ env }) : undefined;
      const verifyAttemptId = randomUUID();
      const reserved = await otpPersistence(() => store.transition({
        challengeTokenHash, from: "sent", now: now(), match: { expiresAt: { $gt: now() } },
        patch: { status: "verifying", verifyAttemptId },
      }));
      if (!reserved) throw failure("OTP_COMPLETION_IN_PROGRESS", 409);
      challenge = reserved;
      const finishAttempt = (status) => otpPersistence(() => store.transition({ challengeTokenHash, from: "verifying", now: now(), match: { verifyAttemptId }, patch: { status } }));
      let reservation;
      try {
        const rates = await otpPersistence(() => getOtpRateStore(deps));
        reservation = await otpPersistence(() => rates.reservePhoneVerifyAttempt(challenge.phone, verifyAttemptId));
      } catch (error) {
        await finishAttempt("sent");
        throw error;
      }

      let result;
      try {
        result = await (deps.verifyTwilioCode ?? verifyTwilioCode)(challenge.phone, payload.code, challenge.verificationSid);
      } catch (error) {
        const classified = classifyTwilioVerifyError(error);
        const knownRejection = ["INVALID_OTP", "OTP_VERIFY_RATE_LIMITED", "OTP_SERVICE_NOT_CONFIGURED"].includes(classified.errorCode);
        await finishAttempt(classified.unknown || (!knownRejection && !classified.retryable) ? "verify_unknown" : "sent");
        if (classified.errorCode === "INVALID_OTP") throw failure(reservation?.verifyFailureCount >= OTP_PHONE_VERIFY_FAILURE_LIMIT ? "OTP_VERIFY_RATE_LIMITED" : "INVALID_OTP", reservation?.verifyFailureCount >= OTP_PHONE_VERIFY_FAILURE_LIMIT ? 429 : 401);
        if (classified.errorCode === "OTP_VERIFY_RATE_LIMITED") throw failure("OTP_VERIFY_RATE_LIMITED", 429);
        throw failure(classified.errorCode === "OTP_SERVICE_NOT_CONFIGURED" ? "OTP_SERVICE_NOT_CONFIGURED" : "OTP_VERIFY_TEMPORARY_FAILURE");
      }

      if (result?.sid !== challenge.verificationSid || result?.to !== challenge.phone) {
        await finishAttempt("verify_unknown");
        throw failure("OTP_VERIFY_TEMPORARY_FAILURE");
      }
      if (result.status !== "approved") {
        if (result.status === "pending") {
          await finishAttempt("sent");
          throw failure(reservation?.verifyFailureCount >= OTP_PHONE_VERIFY_FAILURE_LIMIT ? "OTP_VERIFY_RATE_LIMITED" : "INVALID_OTP", reservation?.verifyFailureCount >= OTP_PHONE_VERIFY_FAILURE_LIMIT ? 429 : 401);
        }
        await finishAttempt("verify_unknown");
        throw failure(result.status === "expired" ? "OTP_VERIFICATION_EXPIRED" : "OTP_VERIFY_TEMPORARY_FAILURE", result.status === "expired" ? 401 : 503);
      }
      const observedAt = +now();
      if (observedAt >= +challenge.expiresAt) {
        await finishAttempt("verify_unknown");
        throw failure("OTP_VERIFICATION_EXPIRED", 401);
      }
      const observed = { operation: "verify", challengeTokenHash, phone: challenge.phone, purpose: challenge.purpose,
        attemptId: verifyAttemptId, verificationSid: result.sid, observedAt, expiresAt: observedAt + OTP_GRANT_TTL_MS, sessionTtlSeconds };
      receipt = sealOtpReceipt(observed, env);
      challenge = await saveApproval(observed);
      logOtpEvent({ correlationId: challenge.correlationId, stage: "verify", provider: "twilio", decision: "success" });
    }

    if (!validDate(challenge.completionExpiresAt) || challenge.completionExpiresAt <= now()) throw failure("OTP_VERIFICATION_EXPIRED", 401);
    let result;
    if (challenge.purpose === "login") {
      const ttl = challenge.sessionTtlSeconds;
      const remaining = Math.floor(+challenge.approvedAt / 1000) + ttl - Math.floor(+now() / 1000);
      if (!Number.isSafeInteger(ttl) || ttl <= 0 || remaining <= 0) throw failure("OTP_VERIFICATION_EXPIRED", 401);
      const sessionToken = await (deps.signCustomerSession ?? signCustomerSession)(challenge.phone, { env, now: challenge.approvedAt, ttlSeconds: ttl });
      if (typeof sessionToken !== "string" || !sessionToken) throw failure();
      challenge = await persistObservedResult(store, { challengeTokenHash, from: "approved", now: now(),
        match: { completionExpiresAt: { $gt: now() } }, patch: { status: "completed", completedAt: challenge.approvedAt, completionId: challenge._id },
      }, (value) => value.status === "completed" && +value.approvedAt === +challenge.approvedAt);
      result = { purpose: "login", sessionToken, sessionTtlSeconds: remaining };
    } else {
      const profile = await otpPersistence(() => readProfile(challenge.phone, deps));
      const verificationToken = deriveBookingToken(payload.challengeToken, env);
      const grant = await (deps.issueBookingGrant ?? issueBookingGrant)({ challenge, challengeTokenHash, verificationToken }, deps);
      if (typeof grant?.verificationToken !== "string" || !grant.verificationToken) throw failure();
      result = { success: true, purpose: "booking", verificationToken: grant.verificationToken,
        expiresInSeconds: Math.max(0, Math.floor((+challenge.completionExpiresAt - +now()) / 1000)), profile };
    }
    logOtpEvent({ correlationId: challenge.correlationId, stage: "complete", provider: "twilio", decision: "success" });
    return result;
  } catch (error) {
    const safe = attachOtpAttemptMetadata(error instanceof OtpError ? error : error instanceof OtpVerificationGrantError ? failure(error.code, error.status) : failure(), { correlationId: challenge?.correlationId, now: now() });
    if (receipt) safe.recoveryReceipt = receipt;
    logOtpEvent({ ...safe, errorCode: safe.code, stage: "complete", provider: "twilio", decision: safe.status === 429 ? "blocked" : "failed" });
    throw safe;
  }
}
