import axios from "axios";
import { logOtpEvent } from "./diagnostics";
import { classifyFirebaseSendFailure, isFirebaseModuleLoadError } from "./firebaseSendPolicy";
import { firebaseErrorDiagnostic, firebaseFailureDetails, projectFirebaseDiagnostic } from "./firebaseDiagnostics";

const PROOF_LIFETIME_MS = 300_000;
const MAX_COMPLETION_ATTEMPTS = 3;

function flowError(code) {
  return Object.assign(new Error("Unable to continue OTP verification."), { code });
}

function assertCurrent(isCurrentAttempt) {
  if (!isCurrentAttempt()) {
    const error = new Error("OTP flow was cancelled.");
    error.code = "OTP_FLOW_CANCELLED";
    throw error;
  }
}

function assertProvider(flow) {
  if (!["twilio", "firebase"].includes(flow?.provider)) {
    const error = new Error("Unsupported OTP provider.");
    error.code = "OTP_PROVIDER_UNSUPPORTED";
    throw error;
  }
  if (flow.provider === "firebase" && flow.providerPolicy !== "firebase_first") {
    throw flowError("OTP_PROVIDER_MISMATCH");
  }
}

function responseErrorCode(error) {
  const value = error?.response?.data?.error;
  return (typeof value === "string" ? value : value?.code) || error?.code;
}

function clearRecovery(flow) {
  delete flow.recoveryReceipt;
  delete flow.recoveryOperation;
}

function recoveryPayload(flow, operation) {
  // A receipt is opaque and usable only by the endpoint that issued it.
  if (flow.recoveryOperation !== operation) clearRecovery(flow);
  return flow.recoveryReceipt ? { recoveryReceipt: flow.recoveryReceipt } : {};
}

function rememberRecovery(flow, operation, error) {
  const receipt = error?.response?.data?.recoveryReceipt;
  if (typeof receipt === "string" && receipt) {
    flow.recoveryReceipt = receipt;
    flow.recoveryOperation = operation;
  }
}

function logFailure(flow, stage, error) {
  const response = error?.response?.data;
  logOtpEvent({
    correlationId: flow?.correlationId,
    stage,
    provider: flow?.provider,
    decision: "failed",
    errorCode: responseErrorCode(error),
    restrictionScope: response?.restrictionScope,
    retryAt: response?.retryAt,
    retryAfterSeconds: response?.retryAfterSeconds,
  });
}

export function createOtpApiClient(http = axios) {
  return {
    challenge: async (payload) =>
      (await http.post("/api/otp/challenge", payload)).data,
    send: async (payload) =>
      (await http.post("/api/otp/send", payload)).data,
    firebaseSend: async (payload) =>
      (await http.post("/api/otp/firebase-send", payload, ...(payload.operation === "diagnostic" ? [{ timeout: 5000 }] : []))).data,
    fallback: async (payload) =>
      (await http.post("/api/otp/fallback", payload)).data,
    complete: async (payload) =>
      (await http.post("/api/otp/complete", payload)).data,
  };
}

export async function startOtpClientFlow({
  phone,
  purpose,
  api,
  onChallenge = () => {},
  onPrepared = () => {},
  firebaseClient,
  getFirebaseClient,
  onStage = () => {},
  isCurrentAttempt = () => true,
}) {
  let challenge;
  try {
    assertCurrent(isCurrentAttempt);
    challenge = await api.challenge({ phone, purpose });
  } catch (error) {
    logFailure(null, "challenge", error);
    throw error;
  }
  onChallenge({
    retryAfterSeconds: challenge.retryAfterSeconds,
    retryAt: challenge.retryAt,
    serverTime: challenge.serverTime,
  });
  assertCurrent(isCurrentAttempt);
  assertProvider(challenge);
  const flow = {
    challengeToken: challenge.challengeToken,
    purpose,
    provider: challenge.provider,
    providerPolicy: challenge.providerPolicy,
    providerState: challenge.providerState,
    phone: challenge.phone || phone,
    ...(challenge.firebaseSendId ? { firebaseSendId: challenge.firebaseSendId, reservationRequested: true } : {}),
    sendStatus: "prepared",
    expiresAt: challenge.expiresAt,
    correlationId: challenge.correlationId,
    retryAfterSeconds: challenge.retryAfterSeconds,
    retryAt: challenge.retryAt,
    serverTime: challenge.serverTime,
  };
  onPrepared(flow);
  return sendOtpClientFlow({ flow, api, firebaseClient, getFirebaseClient, onStage, isCurrentAttempt });
}

function rememberSendSuccess(flow, result) {
  flow.sendStatus = "sent";
  flow.providerState = result.providerState || result.status;
  flow.sendRetry = {
    retryAt: result.retryAt,
    serverTime: result.serverTime,
    retryAfterSeconds: result.retryAfterSeconds,
  };
  clearRecovery(flow);
}

function diagnosticPayload(value) {
  const diagnostic = projectFirebaseDiagnostic(value);
  return Object.keys(diagnostic).length ? { diagnostic } : {};
}

function reportClientFailure(flow, api, error, stage, boundary) {
  if (!flow.firebaseSendId || flow.provider !== "firebase") return;
  const diagnostic = projectFirebaseDiagnostic(error?.firebaseDiagnostic ?? firebaseErrorDiagnostic(error, boundary));
  const safe = firebaseFailureDetails(error?.firebaseFailure ?? { code: "client/unclassified", stage, provenance: "client" }, diagnostic);
  const report = { code: safe.errorCode, stage: safe.failureStage, provenance: safe.failureProvenance };
  // Diagnostics neither block the UI nor retry OTP operations. Server also caps and deduplicates.
  const fingerprint = JSON.stringify([report.code, report.stage, report.provenance, diagnostic]);
  flow.diagnosticReports ??= new Set();
  if (flow.diagnosticReports.size >= 6 || flow.diagnosticReports.has(fingerprint)) return;
  flow.diagnosticReports.add(fingerprint);
  const pending = safe.failureCategory === "pending";
  logOtpEvent({ correlationId: flow.correlationId, purpose: flow.purpose, provider: "firebase",
    stage: pending ? "firebase_send_unknown" : "firebase_client_failure", decision: pending ? "blocked" : "failed", reason: "client_reported", ...safe });
  try {
    Promise.resolve(api.firebaseSend({ challengeToken: flow.challengeToken, firebaseSendId: flow.firebaseSendId,
      operation: "diagnostic", failure: report, ...diagnosticPayload(diagnostic) })).catch(() => {});
  } catch { /* Best effort: never replace the original failure. */ }
}

async function replayFallback({ flow, api, onStage, isCurrentAttempt }) {
  // Once transfer is requested, Firebase proof must never be used again.
  flow.clearProof?.();
  flow.provider = "twilio";
  delete flow.confirmationResult;
  delete flow.idToken;
  onStage("fallback");
  try {
    const result = await api.fallback({
      challengeToken: flow.challengeToken,
      firebaseSendId: flow.firebaseSendId,
      failure: flow.fallbackFailure,
      ...diagnosticPayload(flow.failureDiagnostic),
      ...recoveryPayload(flow, "fallback"),
    });
    assertCurrent(isCurrentAttempt);
    if (result?.provider !== "twilio" || result.status !== "pending") throw flowError("OTP_SEND_PENDING");
    rememberSendSuccess(flow, result);
    flow.fallbackPending = false;
    return flow;
  } catch (error) {
    if (isCurrentAttempt()) {
      rememberRecovery(flow, "fallback", error);
      if (error?.response?.data?.restartAllowed === true && !error.response.data.recoveryReceipt) flow.sendStatus = "failed";
    }
    throw error;
  }
}

async function switchToTwilio({ flow, failure, diagnostic, ...options }) {
  if (["confirm", "token"].includes(failure.stage) && flow.sendStatus !== "sent") {
    // Keep the Firebase confirmation recoverable while its accepted-send write is unresolved.
    const accepted = await options.api.firebaseSend({ challengeToken: flow.challengeToken, firebaseSendId: flow.firebaseSendId, operation: "accepted" });
    assertCurrent(options.isCurrentAttempt);
    if (accepted?.provider !== "firebase" || accepted.status !== "pending") throw flowError("OTP_SEND_PENDING");
    rememberSendSuccess(flow, accepted);
  }
  flow.fallbackFailure = { code: failure.code, stage: failure.stage, provenance: failure.provenance };
  flow.failureDiagnostic = projectFirebaseDiagnostic(diagnostic);
  flow.fallbackPending = true;
  flow.sendStatus = "prepared";
  clearRecovery(flow);
  await replayFallback({ flow, ...options });
  return { requiresNewCode: true, provider: "twilio" };
}

export async function requestAlternativeOtp({ flow, api, onStage = () => {}, isCurrentAttempt = () => true }) {
  assertCurrent(isCurrentAttempt);
  if (flow?.provider !== "firebase" || flow.sendStatus !== "sent" || flow.proofObtained || flow.firebaseRecoveryBlocked || flow.completePromise || flow.sendPromise) throw flowError("OTP_PROVIDER_REJECTED");
  return switchToTwilio({ flow, api, onStage, isCurrentAttempt,
    failure: { code: "client/sms-not-received", stage: "delivery", provenance: "client" } });
}

async function sendFirebase({ flow, api, firebaseClient, getFirebaseClient, onStage, isCurrentAttempt }) {
  const payload = (operation) => ({
    challengeToken: flow.challengeToken,
    operation,
    ...(flow.firebaseSendId ? { firebaseSendId: flow.firebaseSendId } : {}),
  });
  if (flow.sendStatus === "sent") return flow;
  if (flow.rejectedFailure) {
    if (flow.rejectionRequested) {
      const status = await api.firebaseSend(payload("status"));
      assertCurrent(isCurrentAttempt);
      if (status?.provider !== "firebase" || status.firebaseSendId !== flow.firebaseSendId || status.phone !== flow.phone) throw flowError("OTP_SEND_PENDING");
      flow.providerState = status.providerState || status.status;
      if (status.status === "failed") {
        flow.sendStatus = "failed";
        throw flow.rejectionError;
      }
      if (status.status !== "sending") throw flowError("OTP_SEND_PENDING");
    }
    flow.rejectionRequested = true;
    const result = await api.firebaseSend({ ...payload("rejected"), failure: flow.rejectedFailure, ...diagnosticPayload(flow.failureDiagnostic) });
    assertCurrent(isCurrentAttempt);
    if (result?.provider !== "firebase" || result.status !== "failed") throw flowError("OTP_SEND_PENDING");
    flow.providerState = result.providerState || result.status;
    flow.sendStatus = "failed";
    throw flow.rejectionError;
  }
  if (!flow.confirmationResult) {
    const operation = flow.reservationRequested ? "status" : "reserve";
    flow.reservationRequested = true;
    const reservation = await api.firebaseSend(payload(operation));
    assertCurrent(isCurrentAttempt);
    if (reservation?.provider !== "firebase" || reservation.phone !== flow.phone ||
        typeof reservation.firebaseSendId !== "string" || !reservation.firebaseSendId) throw flowError("OTP_SEND_PENDING");
    if (flow.firebaseSendId && flow.firebaseSendId !== reservation.firebaseSendId) throw flowError("OTP_PROVIDER_MISMATCH");
    flow.firebaseSendId = reservation.firebaseSendId;
    flow.providerState = reservation.providerState || reservation.status;
    if (operation !== "reserve" || reservation.status !== "reserved" || flow.sdkSendStarted) {
      if (reservation.status === "failed") flow.sendStatus = "failed";
      throw flowError(reservation.status === "failed" ? "OTP_SEND_FAILED" : "OTP_SEND_PENDING");
    }
    flow.sdkSendStarted = true;
    let clientLoaded = false;
    try {
      const client = firebaseClient || await getFirebaseClient();
      clientLoaded = true;
      assertCurrent(isCurrentAttempt);
      onStage("sending");
      const confirmationResult = await client.send(flow.phone, {
        correlationId: flow.correlationId,
        onStage: (stage) => {
          if (!isCurrentAttempt()) return;
          if (stage?.status === "pending" && stage.firebaseFailure) {
            reportClientFailure(flow, api, { firebaseFailure: stage.firebaseFailure }, stage.stage, stage.stage);
          }
          onStage(stage);
        },
        isCurrentAttempt,
      });
      assertCurrent(isCurrentAttempt);
      if (!confirmationResult) throw flowError("OTP_SEND_PENDING");
      flow.confirmationResult = confirmationResult;
      flow.clearProof = () => {
        clearTimeout(flow.proofTimer);
        if (flow.confirmationResult) {
          try { client.clearConfirmation?.(flow.confirmationResult); } catch { /* Cleanup must not undo application completion. */ }
        }
        delete flow.proofTimer;
        delete flow.idToken;
        delete flow.confirmationResult;
      };
    } catch (error) {
      assertCurrent(isCurrentAttempt);
      const failure = !clientLoaded && isFirebaseModuleLoadError(error)
        ? { code: "client/module-load-failed", stage: "initialize", provenance: "client" }
        : error?.firebaseFailure;
      flow.failureDiagnostic = projectFirebaseDiagnostic(error?.firebaseDiagnostic);
      if (!clientLoaded && failure?.code === "client/module-load-failed") flow.failureDiagnostic = firebaseErrorDiagnostic(error, "firebase_client_load");
      if (!["confirm", "token", "delivery", "server_verify"].includes(failure?.stage) && classifyFirebaseSendFailure(failure).eligible) {
        flow.fallbackFailure = { code: failure.code, stage: failure.stage, provenance: failure.provenance };
        flow.fallbackPending = true;
        return replayFallback({ flow, api, onStage, isCurrentAttempt });
      }
      if (failure && [failure.code, failure.stage, failure.provenance].every((value) => typeof value === "string" && /^[a-zA-Z0-9_/-]{1,80}$/.test(value))) {
        flow.rejectedFailure = { code: failure.code, stage: failure.stage, provenance: failure.provenance };
        flow.rejectionError = error;
        return sendFirebase({ flow, api, onStage, isCurrentAttempt });
      }
      reportClientFailure(flow, api, error, clientLoaded ? "send" : "initialize", clientLoaded ? "firebase_send" : "firebase_client_load");
      flow.sendStatus = "failed";
      throw error;
    }
  }
  onStage("acknowledging");
  const accepted = await api.firebaseSend(payload("accepted"));
  assertCurrent(isCurrentAttempt);
  if (accepted?.provider !== "firebase" || accepted.status !== "pending") throw flowError("OTP_SEND_PENDING");
  rememberSendSuccess(flow, accepted);
  return flow;
}

export async function sendOtpClientFlow(options) {
  const { flow, isCurrentAttempt = () => true } = options;
  assertCurrent(isCurrentAttempt);
  assertProvider(flow);
  if (flow.sendPromise) return flow.sendPromise;
  const pending = runSend({ ...options, isCurrentAttempt });
  flow.sendPromise = pending;
  try { return await pending; }
  catch (error) {
    if (isCurrentAttempt() && flow.provider === "firebase") {
      const response = error?.response?.data;
      if (response?.restartAllowed === true && !response.recoveryReceipt) flow.sendStatus = "failed";
      logFailure(flow, "send", error);
    }
    throw error;
  }
  finally { if (flow.sendPromise === pending) delete flow.sendPromise; }
}

async function runSend({
  flow,
  api,
  firebaseClient,
  getFirebaseClient,
  onStage = () => {},
  isCurrentAttempt = () => true,
}) {
  assertCurrent(isCurrentAttempt);
  assertProvider(flow);
  if (flow.fallbackPending) return replayFallback({ flow, api, onStage, isCurrentAttempt });
  if (flow.provider === "firebase") return sendFirebase({ flow, api, firebaseClient, getFirebaseClient, onStage, isCurrentAttempt });
  try {
    const result = await api.send({
      challengeToken: flow.challengeToken,
      ...recoveryPayload(flow, "send"),
    });
    assertCurrent(isCurrentAttempt);
    if (result?.provider !== "twilio" || result?.status !== "pending") {
      const error = new Error("Unable to confirm OTP send.");
      error.code = "OTP_SEND_PENDING";
      throw error;
    }
    flow.sendStatus = "sent";
    flow.sendRetry = {
      retryAt: result.retryAt,
      serverTime: result.serverTime,
      retryAfterSeconds: result.retryAfterSeconds,
    };
    clearRecovery(flow);
    logOtpEvent({ correlationId: flow.correlationId, stage: "send", provider: "twilio", decision: "success" });
    return flow;
  } catch (error) {
    if (isCurrentAttempt()) {
      rememberRecovery(flow, "send", error);
      const response = error?.response?.data;
      // Only the server can declare an unresolved send safe to restart.
      if (response?.restartAllowed === true && !response.recoveryReceipt) {
        flow.sendStatus = "failed";
      }
    }
    logFailure(flow, "send", error);
    throw error;
  }
}

export async function completeOtpClientFlow(options) {
  const { flow, isCurrentAttempt = () => true } = options;
  assertCurrent(isCurrentAttempt);
  assertProvider(flow);
  if (flow.completePromise) return flow.completePromise;
  const pending = runComplete({ ...options, isCurrentAttempt });
  flow.completePromise = pending;
  try { return await pending; }
  finally { if (flow.completePromise === pending) delete flow.completePromise; }
}

async function runComplete({
  flow,
  code,
  api,
  firebaseClient,
  getFirebaseClient,
  onStage = () => {},
  isCurrentAttempt = () => true,
}) {
  assertCurrent(isCurrentAttempt);
  assertProvider(flow);
  let completionRequested = false;
  try {
    let proof = { code };
    if (flow.fallbackPending) {
      await sendOtpClientFlow({ flow, api, onStage, isCurrentAttempt });
      return { requiresNewCode: true, provider: "twilio" };
    }
    if (flow.provider === "firebase") {
      if (flow.proofObtained && (!flow.idToken || Date.now() >= flow.proofExpiresAt || flow.completionAttempts >= MAX_COMPLETION_ATTEMPTS)) {
        flow.clearProof?.();
        throw flowError("OTP_VERIFICATION_EXPIRED");
      }
      if (!flow.idToken) {
        if (!flow.confirmationResult) throw flowError("OTP_SEND_PENDING");
        // Verified proof can recover server sending state even if acceptance persistence failed.
        const client = firebaseClient || await getFirebaseClient();
        assertCurrent(isCurrentAttempt);
        const idToken = await client.confirm(flow.confirmationResult, code);
        assertCurrent(isCurrentAttempt);
        if (typeof idToken !== "string" || !idToken) throw flowError("OTP_VERIFY_TEMPORARY_FAILURE");
        flow.idToken = idToken;
        flow.proofObtained = true;
        flow.proofExpiresAt = Date.now() + PROOF_LIFETIME_MS;
        flow.completionAttempts = 0;
        flow.proofTimer = setTimeout(() => flow.clearProof?.(), PROOF_LIFETIME_MS);
        flow.proofTimer.unref?.();
      }
      flow.completionAttempts += 1;
      proof = { idToken: flow.idToken };
    }
    completionRequested = true;
    const result = await api.complete({
      challengeToken: flow.challengeToken,
      purpose: flow.purpose,
      ...proof,
      ...recoveryPayload(flow, "complete"),
    });
    assertCurrent(isCurrentAttempt);
    clearRecovery(flow);
    flow.clearProof?.();
    logOtpEvent({ correlationId: flow.correlationId, stage: "complete", provider: flow.provider, decision: "success" });
    return result;
  } catch (error) {
    if (isCurrentAttempt() && !completionRequested && flow.provider === "firebase") {
      reportClientFailure(flow, api, error, "confirm", "firebase_confirm");
      const failure = error?.firebaseFailure;
      if (["invalid_code", "expired_code", "security_rejection", "provider_throttle", "quota_or_billing", "configuration", "app_verification"].includes(firebaseFailureDetails(failure).failureCategory)) flow.firebaseRecoveryBlocked = true;
      if (!flow.firebaseRecoveryBlocked && ["confirm", "token"].includes(failure?.stage) && classifyFirebaseSendFailure(failure).eligible) {
        return switchToTwilio({ flow, api, onStage, isCurrentAttempt, failure, diagnostic: error.firebaseDiagnostic });
      }
    }
    if (isCurrentAttempt() && completionRequested && flow.provider === "firebase" && !flow.firebaseRecoveryBlocked &&
        responseErrorCode(error) === "OTP_VERIFY_TEMPORARY_FAILURE" && error?.response?.data?.firebaseFallbackAllowed === true) {
      return switchToTwilio({ flow, api, onStage, isCurrentAttempt,
        failure: { code: "server/firebase-verification-unavailable", stage: "server_verify", provenance: "server" } });
    }
    if (isCurrentAttempt() && completionRequested) rememberRecovery(flow, "complete", error);
    logFailure(flow, "complete", error);
    throw error;
  }
}
