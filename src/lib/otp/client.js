import axios from "axios";
import { logOtpEvent } from "./diagnostics";

function assertCurrent(isCurrentAttempt) {
  if (!isCurrentAttempt()) {
    const error = new Error("OTP flow was cancelled.");
    error.code = "OTP_FLOW_CANCELLED";
    throw error;
  }
}

function assertProvider(flow) {
  if (flow?.provider !== "twilio") {
    const error = new Error("Unsupported OTP provider.");
    error.code = "OTP_PROVIDER_UNSUPPORTED";
    throw error;
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
    provider: "twilio",
    sendStatus: "prepared",
    expiresAt: challenge.expiresAt,
    correlationId: challenge.correlationId,
    retryAfterSeconds: challenge.retryAfterSeconds,
    retryAt: challenge.retryAt,
    serverTime: challenge.serverTime,
  };
  onPrepared(flow);
  return sendOtpClientFlow({ flow, api, isCurrentAttempt });
}

export async function sendOtpClientFlow({
  flow,
  api,
  isCurrentAttempt = () => true,
}) {
  assertCurrent(isCurrentAttempt);
  assertProvider(flow);
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

export async function completeOtpClientFlow({
  flow,
  code,
  api,
  isCurrentAttempt = () => true,
}) {
  assertCurrent(isCurrentAttempt);
  assertProvider(flow);
  try {
    const result = await api.complete({
      challengeToken: flow.challengeToken,
      purpose: flow.purpose,
      code,
      ...recoveryPayload(flow, "complete"),
    });
    assertCurrent(isCurrentAttempt);
    clearRecovery(flow);
    logOtpEvent({ correlationId: flow.correlationId, stage: "complete", provider: "twilio", decision: "success" });
    return result;
  } catch (error) {
    if (isCurrentAttempt()) rememberRecovery(flow, "complete", error);
    logFailure(flow, "complete", error);
    throw error;
  }
}
