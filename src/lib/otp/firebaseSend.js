import { randomUUID } from "node:crypto";
import { hashBearerToken, otpSecretKey } from "./crypto";
import { OtpError, otpPersistence, attachOtpAttemptMetadata } from "./errors";
import { getOtpChallengeStore } from "./challengeStore";
import { deriveOtpSourceHash } from "./sourceIdentity";
import { classifyFirebaseSendFailure } from "./firebaseSendPolicy";
import { requestTwilioSend } from "./twilioSend";
import { logOtpEvent } from "./diagnostics";
import { firebaseFailureDetails } from "./firebaseDiagnostics";

const fail = (code = "OTP_PROVIDER_REJECTED", status = 400) => new OtpError(code, status, "The OTP provider operation is not allowed.");
const uuid = (value) => typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);

async function context(input, deps) {
  const env = deps.env ?? process.env;
  const now = () => new Date(deps.clock?.now() ?? Date.now());
  otpSecretKey("receipt", env);
  if (typeof input?.challengeToken !== "string" || !/^[\w-]{43}$/.test(input.challengeToken)) throw fail("OTP_CHALLENGE_FAILED");
  const challengeTokenHash = hashBearerToken(input.challengeToken);
  const store = deps.challengeStore ?? await otpPersistence(() => getOtpChallengeStore());
  const challenge = await otpPersistence(() => store.findByTokenHash(challengeTokenHash));
  if (!challenge || challenge.providerPolicy !== "firebase_first") throw fail();
  if (!(challenge.expiresAt instanceof Date) || !Number.isFinite(+challenge.expiresAt) || challenge.expiresAt <= now()) throw fail("OTP_CHALLENGE_EXPIRED");
  const sourceHash = await (deps.deriveSourceHash ?? deriveOtpSourceHash)(input.request, { env });
  if (sourceHash !== challenge.sourceHash) throw fail("OTP_CHALLENGE_FAILED");
  return { challenge, challengeTokenHash, store, now };
}

function snapshot(challenge) {
  if (challenge.provider === "twilio") return { provider: "twilio", status: "sending", firebaseSendId: challenge.firebaseSendId, phone: challenge.phone };
  const status = ["firebase_sent", "verifying", "approved", "completed"].includes(challenge.status) ? "pending" : challenge.status === "failed" ? "failed" : "sending";
  return { provider: "firebase", status, firebaseSendId: challenge.firebaseSendId, phone: challenge.phone };
}

async function recordClientFailure(ctx, input) {
  if (!input.failure || !["code", "stage", "provenance"].every(key => typeof input.failure[key] === "string" && input.failure[key].length <= 80)) throw fail();
  const details = firebaseFailureDetails(input.failure, input.diagnostic);
  const fingerprint = JSON.stringify(details);
  let challenge = ctx.challenge;
  // Bounded best-effort telemetry. CAS never changes OTP ownership, expiry or approval.
  for (let attempt = 0; attempt < 3; attempt += 1) {
    if (!challenge || challenge.provider !== "firebase" || !["firebase_sending", "firebase_sent", "verifying"].includes(challenge.status)) return { recorded: false };
    const records = challenge.firebaseClientFailures ?? [];
    if (records.length >= 6 || records.some(({ observedAt: _at, ...record }) => JSON.stringify(record) === fingerprint)) return { recorded: false };
    const version = challenge.firebaseDiagnosticVersion;
    const updated = await otpPersistence(() => ctx.store.transition({ challengeTokenHash: ctx.challengeTokenHash, provider: "firebase", from: challenge.status, now: ctx.now(),
      match: { firebaseSendId: input.firebaseSendId, expiresAt: { $gt: ctx.now() }, firebaseDiagnosticVersion: version ?? { $exists: false } },
      patch: { firebaseDiagnosticVersion: (version ?? 0) + 1, firebaseClientFailures: [...records, { ...details, observedAt: ctx.now() }] } }));
    if (updated) {
      const pending = details.failureCategory === "pending";
      logOtpEvent({ correlationId: challenge.correlationId, purpose: challenge.purpose, provider: "firebase",
        stage: pending ? "firebase_send_unknown" : "firebase_client_failure", decision: pending ? "blocked" : "failed", reason: "client_reported", ...details });
      return { recorded: true };
    }
    challenge = await otpPersistence(() => ctx.store.findByTokenHash(ctx.challengeTokenHash));
  }
  return { recorded: false };
}

export async function requestFirebaseSend(input, deps = {}) {
  let challenge;
  try {
    const ctx = await context(input, deps);
    ({ challenge } = ctx);
    const { store, challengeTokenHash, now } = ctx;
    if (!["reserve", "accepted", "rejected", "status", "diagnostic"].includes(input.operation)) throw fail();
    if (input.operation === "status") return snapshot(challenge);
    if (challenge.provider !== "firebase") throw fail();
    if (input.operation === "reserve") {
      if (challenge.status !== "prepared") return snapshot(challenge);
      const firebaseSendId = randomUUID();
      const reserved = await otpPersistence(() => store.transition({ challengeTokenHash, provider: "firebase", from: "prepared", now: now(),
        match: { expiresAt: { $gt: now() } }, patch: { status: "firebase_sending", firebaseSendId } }));
      if (!reserved) return snapshot(await otpPersistence(() => store.findByTokenHash(challengeTokenHash)) || challenge);
      logOtpEvent({ correlationId: challenge.correlationId, stage: "firebase_send_started", provider: "firebase", decision: "reserved" });
      return { provider: "firebase", status: "reserved", firebaseSendId, phone: challenge.phone };
    }
    if (!uuid(input.firebaseSendId) || input.firebaseSendId !== challenge.firebaseSendId) throw fail();
    if (input.operation === "diagnostic") return await recordClientFailure(ctx, input);
    if (input.operation === "accepted" && ["firebase_sent", "verifying", "approved", "completed"].includes(challenge.status)) {
      const updated = await otpPersistence(() => store.transition({ challengeTokenHash, provider: "firebase", from: ["firebase_sent", "verifying", "approved", "completed"], now: now(),
        match: { firebaseSendId: input.firebaseSendId }, patch: { firebaseAcceptedAt: challenge.firebaseAcceptedAt ?? now() } }));
      if (!updated) throw fail();
      return snapshot(updated);
    }
    if (challenge.status !== "firebase_sending") throw fail();
    const details = input.operation === "rejected" ? firebaseFailureDetails(input.failure, input.diagnostic) : undefined;
    if (details) {
      logOtpEvent({ correlationId: challenge.correlationId, purpose: challenge.purpose, stage: "firebase_send_rejected", provider: "firebase", decision: "failed", reason: "client_reported", ...details });
    }
    const patch = input.operation === "accepted" ? { status: "firebase_sent", firebaseAcceptedAt: now() }
      : { status: "failed", firebaseSendFailure: { ...details, observedAt: now() } };
    const updated = await otpPersistence(() => store.transition({ challengeTokenHash, provider: "firebase", from: "firebase_sending", now: now(),
      match: { firebaseSendId: input.firebaseSendId, expiresAt: { $gt: now() } }, patch }));
    if (!updated) throw fail();
    if (input.operation === "accepted") logOtpEvent({ correlationId: challenge.correlationId, purpose: challenge.purpose, stage: "firebase_send_accepted", provider: "firebase", decision: "success" });
    return snapshot(updated);
  } catch (error) {
    const safe = attachOtpAttemptMetadata(error instanceof OtpError ? error : fail("OTP_SEND_FAILED", 503), { correlationId: challenge?.correlationId, phoneRetryAt: challenge?.retryAt, now: new Date(deps.clock?.now() ?? Date.now()) });
    if (safe.code === "OTP_CHALLENGE_EXPIRED" && !safe.recoveryReceipt) safe.restartAllowed = true;
    throw safe;
  }
}

export async function requestFirebaseFallback(input, deps = {}) {
  let challenge;
  try {
    const ctx = await context(input, deps);
    ({ challenge } = ctx);
    const { store, challengeTokenHash, now } = ctx;
    const decision = classifyFirebaseSendFailure(input.failure);
    const details = firebaseFailureDetails(input.failure, input.diagnostic);
    logOtpEvent({ correlationId: challenge.correlationId, purpose: challenge.purpose, stage: "fallback_decision", provider: "firebase", decision: decision.eligible ? "reserved" : "reject", reason: decision.reason, ...details });
    if (!decision.eligible || !uuid(input.firebaseSendId) || input.firebaseSendId !== challenge.firebaseSendId) throw fail();
    const report = { code: input.failure.code, stage: input.failure.stage, provenance: input.failure.provenance };
    const sameFallback = (value) => value?.provider === "twilio" && value.firebaseSendId === input.firebaseSendId &&
      value.fallbackFailure?.code === report.code && value.fallbackFailure?.stage === report.stage && value.fallbackFailure?.provenance === report.provenance;
    if (!sameFallback(challenge)) {
      if (challenge.provider !== "firebase" || challenge.status !== "firebase_sending" || challenge.firebaseCompletionStartedAt) throw fail();
      const transitioned = await otpPersistence(() => store.transition({ challengeTokenHash, provider: "firebase", from: "firebase_sending", now: now(),
        match: { firebaseSendId: input.firebaseSendId, expiresAt: { $gt: now() }, firebaseCompletionStartedAt: { $exists: false } },
        patch: { provider: "twilio", status: "prepared", fallbackFailure: report, fallbackAt: now(), fallbackAmbiguous: decision.ambiguous === true,
          firebaseSendFailure: { ...details, observedAt: now() } } }));
      challenge = transitioned || await otpPersistence(() => store.findByTokenHash(challengeTokenHash));
      if (!sameFallback(challenge)) throw fail();
    }
    logOtpEvent({ correlationId: challenge.correlationId, stage: "twilio_fallback_reserved", provider: "twilio", decision: "reserved" });
    // The existing sender owns paid budgets, atomic dispatch, receipts, and replay.
    return await requestTwilioSend(input, deps);
  } catch (error) {
    const safe = attachOtpAttemptMetadata(error instanceof OtpError ? error : fail("OTP_SEND_FAILED", 503), { correlationId: challenge?.correlationId, phoneRetryAt: challenge?.retryAt, now: new Date(deps.clock?.now() ?? Date.now()) });
    if (safe.code === "OTP_CHALLENGE_EXPIRED" && !safe.recoveryReceipt) safe.restartAllowed = true;
    throw safe;
  }
}
