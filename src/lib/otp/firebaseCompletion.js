import { randomUUID } from "node:crypto";
import { verifyFirebaseEvidence } from "./firebaseEvidence";
import { OtpError, otpPersistence } from "./errors";
import { getOtpRateStore } from "./stores";
import { getCustomerSessionTtlSeconds } from "@/lib/customerSession";
import { OTP_GRANT_TTL_MS } from "./constants";
import { openOtpReceipt, sealOtpReceipt, persistObservedResult, isUncommittedFirebaseReservation } from "./recovery";
import { logOtpEvent } from "./diagnostics";

const fail = (code, status = 503) => new OtpError(code, status, "Firebase verification could not be completed.");
const approved = (value) => value?.provider === "firebase" && ["approved", "completed"].includes(value.status) && value.approvedAt instanceof Date && Number.isFinite(+value.approvedAt);

export async function approveFirebaseChallenge(payload, initial, store, deps = {}) {
  const env = deps.env ?? process.env;
  const now = () => new Date(deps.clock?.now() ?? Date.now());
  const challengeTokenHash = initial.challengeTokenHash;
  let challenge = initial;
  let receipt;
  function reservationRetryReceipt(attemptId) {
    return sealOtpReceipt({ operation: "firebase_retry", provider: "firebase", retry: true, challengeTokenHash,
      phone: challenge.phone, purpose: challenge.purpose, attemptId, firebaseSendId: challenge.firebaseSendId,
      reservation: true, previousStatus: challenge.status, previousAttemptId: challenge.verifyAttemptId ?? null,
      observedAt: +now(), expiresAt: +challenge.expiresAt }, env);
  }
  async function saveApproval(observed) {
    return persistObservedResult(store, { challengeTokenHash, provider: "firebase", from: "verifying", now: now(),
      match: { verifyAttemptId: observed.attemptId, firebaseSendId: observed.firebaseSendId },
      patch: { status: "approved", approvedAt: new Date(observed.observedAt), completionExpiresAt: new Date(observed.expiresAt),
        sessionTtlSeconds: observed.sessionTtlSeconds, firebaseUid: observed.uid, firebaseAuthTime: observed.authTime } },
    (value) => approved(value) && value.verifyAttemptId === observed.attemptId && value.firebaseSendId === observed.firebaseSendId && value.firebaseUid === observed.uid && value.firebaseAuthTime === observed.authTime);
  }
  async function saveRetry(observed) {
    // An authenticated no-check receipt may also recover a write that never committed.
    // The next reservation still CAS-checks current provider/status; no live owner is reset here.
    if (isUncommittedFirebaseReservation(observed, challenge)) return challenge;
    return persistObservedResult(store, { challengeTokenHash, provider: "firebase", from: "verifying", now: now(),
      match: { verifyAttemptId: observed.attemptId, firebaseSendId: observed.firebaseSendId }, patch: { status: "firebase_sent",
        ...(observed.blockFallback === true ? { firebaseRecoveryBlocked: true } : {}),
        firebaseTechnicalFailureAttempt: observed.technicalFailure === true ? observed.attemptId : null } },
    (value) => value?.provider === "firebase" && value.status === "firebase_sent" && value.verifyAttemptId === observed.attemptId && value.firebaseSendId === observed.firebaseSendId);
  }
  try {
    // Durable approval is authoritative even if a lost response left an older retry receipt in the browser.
    if (approved(challenge)) return { challenge };
    if (payload.recoveryReceipt) {
      let observed;
      try {
        observed = openOtpReceipt(payload.recoveryReceipt, { challenge, operation: "firebase_verify", now: now(), env });
      } catch {
        observed = openOtpReceipt(payload.recoveryReceipt, { challenge, operation: "firebase_retry", now: now(), env });
      }
      receipt = payload.recoveryReceipt;
      if (observed.operation === "firebase_verify") return { challenge: await saveApproval(observed), receipt };
      // This receipt proves only that the previous checker settled without approval.
      challenge = await saveRetry(observed);
      receipt = undefined;
    }
    if (approved(challenge)) return { challenge };
    if (challenge.expiresAt <= now()) throw fail("OTP_VERIFICATION_EXPIRED", 401);
    if (challenge.status === "verifying") throw fail("OTP_COMPLETION_IN_PROGRESS", 409);
    if (!["firebase_sending", "firebase_sent"].includes(challenge.status)) throw fail("OTP_VERIFICATION_INVALID", 401);
    if (typeof payload.idToken !== "string" || payload.idToken.length < 20 || payload.idToken.length > 16384) throw fail("OTP_EVIDENCE_REQUIRED", 400);
    const sessionTtlSeconds = challenge.purpose === "login" ? getCustomerSessionTtlSeconds({ env }) : undefined;
    const verifyAttemptId = randomUUID();
    const previousStatus = challenge.status;
    try {
      challenge = await persistObservedResult(store, { challengeTokenHash, provider: "firebase", from: previousStatus, now: now(),
        match: { firebaseSendId: challenge.firebaseSendId, expiresAt: { $gt: now() } },
        patch: { status: "verifying", verifyAttemptId, firebaseCompletionStartedAt: now() } },
      (value) => value?.provider === "firebase" && value.status === "verifying" && value.verifyAttemptId === verifyAttemptId);
    } catch (error) {
      let competing;
      try { competing = await store.findByTokenHash(challengeTokenHash); } catch { /* Retain the infrastructure error when state is unreadable. */ }
      if (competing?.provider === "twilio") throw fail("OTP_PROVIDER_REJECTED", 400);
      if (competing?.verifyAttemptId && competing.verifyAttemptId !== verifyAttemptId) throw fail("OTP_COMPLETION_IN_PROGRESS", 409);
      // No evidence check has started. Only this reservation may be released after storage recovers.
      receipt = reservationRetryReceipt(verifyAttemptId);
      throw error;
    }
    let evidence;
    let evidenceStarted = false;
    try {
      const rates = await otpPersistence(() => getOtpRateStore(deps));
      await otpPersistence(() => rates.reservePhoneVerifyAttempt(challenge.phone, verifyAttemptId));
      evidenceStarted = true;
      evidence = await (deps.verifyFirebaseEvidence ?? verifyFirebaseEvidence)(payload.idToken, challenge, { env, now: now() });
    } catch (error) {
      const identifiedTechnicalFailure = evidenceStarted && error instanceof OtpError && error.code === "OTP_VERIFY_TEMPORARY_FAILURE" && error.firebaseTechnicalFailure === true;
      const observed = { operation: "firebase_retry", provider: "firebase", retry: true, challengeTokenHash, phone: challenge.phone, purpose: challenge.purpose,
        attemptId: verifyAttemptId, firebaseSendId: challenge.firebaseSendId, observedAt: +now(), expiresAt: +challenge.expiresAt,
        blockFallback: evidenceStarted && !identifiedTechnicalFailure,
        technicalFailure: identifiedTechnicalFailure && challenge.firebaseRecoveryBlocked !== true };
      receipt = sealOtpReceipt(observed, env);
      await saveRetry(observed);
      if (observed.technicalFailure) error.firebaseFallbackAllowed = true;
      throw error instanceof OtpError ? error : fail("OTP_VERIFY_TEMPORARY_FAILURE");
    }
    if (typeof evidence?.uid !== "string" || !evidence.uid || evidence.uid.length > 128 || !Number.isSafeInteger(evidence.authTime) ||
      evidence.authTime < Math.floor(+challenge.createdAt / 1000) || evidence.authTime > Math.floor(+now() / 1000) + 60) throw fail("OTP_VERIFY_TEMPORARY_FAILURE");
    logOtpEvent({ correlationId: challenge.correlationId, provider: "firebase", stage: "firebase_server_evidence_checked", decision: "success" });
    const observedAt = +now();
    if (observedAt >= +challenge.expiresAt) throw fail("OTP_VERIFICATION_EXPIRED", 401);
    const observed = { operation: "firebase_verify", provider: "firebase", challengeTokenHash, phone: challenge.phone, purpose: challenge.purpose,
      attemptId: verifyAttemptId, firebaseSendId: challenge.firebaseSendId, uid: evidence.uid, authTime: evidence.authTime,
      observedAt, expiresAt: observedAt + OTP_GRANT_TTL_MS, sessionTtlSeconds };
    receipt = sealOtpReceipt(observed, env);
    challenge = await saveApproval(observed);
    logOtpEvent({ correlationId: challenge.correlationId, provider: "firebase", stage: "provider_approved", decision: "success" });
    return { challenge, receipt };
  } catch (error) {
    const safe = error instanceof OtpError ? error : fail("OTP_VERIFY_TEMPORARY_FAILURE");
    if (receipt) safe.recoveryReceipt = receipt;
    throw safe;
  }
}
