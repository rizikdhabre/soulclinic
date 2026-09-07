import axios from "axios";
import { classifyFirebaseSendError } from "./firebaseErrors";
import { logOtpEvent } from "./diagnostics";

function assertCurrent(isCurrentAttempt) {
  if (!isCurrentAttempt()) {
    const error = new Error("OTP flow was cancelled.");
    error.code = "OTP_FLOW_CANCELLED";
    throw error;
  }
}

function responseErrorCode(error) {
  const value = error?.response?.data?.error;
  return (typeof value === "string" ? value : value?.code) || error?.code;
}

export function createOtpApiClient(http = axios) {
  return {
    challenge: async (payload) =>
      (await http.post("/api/otp/challenge", payload)).data,
    fallback: async (payload) =>
      (await http.post("/api/otp/fallback", payload)).data,
    complete: async (payload) =>
      (await http.post("/api/otp/complete", payload)).data,
  };
}

export async function startOtpClientFlow({
  phone,
  purpose,
  containerId,
  api,
  sendFirebaseOtp,
  clearFirebaseRecaptcha,
  onChallenge = () => {},
  isCurrentAttempt = () => true,
}) {
  let challenge;
  try {
    assertCurrent(isCurrentAttempt);
    challenge = await api.challenge({ phone, purpose });
  } catch (error) {
    const response = error?.response?.data;
    logOtpEvent({
      stage: "challenge",
      decision: "reject",
      errorCode: responseErrorCode(error),
      correlationId: response?.correlationId,
      restrictionScope: response?.restrictionScope,
      retryAt: response?.retryAt,
      retryAfterSeconds: response?.retryAfterSeconds,
    });
    throw error;
  }
  const flow = {
    challengeToken: challenge.challengeToken,
    provider: challenge.provider,
    expiresAt: challenge.expiresAt,
    retryAfterSeconds: challenge.retryAfterSeconds,
    ...(challenge.retryAt ? { retryAt: challenge.retryAt } : {}),
    ...(challenge.serverTime ? { serverTime: challenge.serverTime } : {}),
    ...(challenge.correlationId ? { correlationId: challenge.correlationId } : {}),
  };
  onChallenge({
    retryAfterSeconds: challenge.retryAfterSeconds,
    retryAt: challenge.retryAt,
    serverTime: challenge.serverTime,
  });
  assertCurrent(isCurrentAttempt);

  if (challenge.provider === "development") {
    return flow;
  }

  if (challenge.provider !== "firebase") {
    const error = new Error("Unsupported OTP provider.");
    error.code = "OTP_PROVIDER_UNSUPPORTED";
    throw error;
  }

  let confirmationResult;
  try {
    confirmationResult = await sendFirebaseOtp(phone, containerId);
  } catch (error) {
    assertCurrent(isCurrentAttempt);
    const classification = classifyFirebaseSendError(error);
    logOtpEvent({
      correlationId: flow.correlationId,
      stage: "firebase_send",
      provider: "firebase",
      errorCode: classification.code,
      decision: classification.action,
    });
    if (classification.action !== "fallback") {
      throw error;
    }

    clearFirebaseRecaptcha(containerId);
    let fallback;
    try {
      fallback = await api.fallback({
        challengeToken: challenge.challengeToken,
        firebaseErrorCode: classification.code,
      });
    } catch (fallbackError) {
      const response = fallbackError?.response?.data;
      logOtpEvent({
        correlationId: flow.correlationId,
        stage: "fallback",
        provider: "twilio",
        errorCode: responseErrorCode(fallbackError),
        decision: "failed",
        restrictionScope: response?.restrictionScope,
        retryAt: response?.retryAt,
        retryAfterSeconds: response?.retryAfterSeconds,
      });
      throw fallbackError;
    }
    assertCurrent(isCurrentAttempt);
    logOtpEvent({ correlationId: flow.correlationId, stage: "fallback", provider: "twilio", decision: "success" });

    return {
      ...flow,
      provider: "twilio",
      retryAfterSeconds:
        fallback.retryAfterSeconds ?? challenge.retryAfterSeconds,
    };
  }
  // Keep post-send work outside the send-error catch: success must never fall back.
  assertCurrent(isCurrentAttempt);
  logOtpEvent({ correlationId: flow.correlationId, stage: "firebase_send", provider: "firebase", decision: "success" });
  return { ...flow, confirmationResult };
}

export async function completeOtpClientFlow({
  flow,
  code,
  api,
  isCurrentAttempt = () => true,
}) {
  assertCurrent(isCurrentAttempt);
  const complete = async (payload) => {
    try {
      assertCurrent(isCurrentAttempt);
      const result = await api.complete(payload);
      assertCurrent(isCurrentAttempt);
      logOtpEvent({ correlationId: flow.correlationId, stage: "complete", provider: flow.provider, decision: "success" });
      return result;
    } catch (error) {
      logOtpEvent({ correlationId: flow.correlationId, stage: "complete", provider: flow.provider, decision: "failed", errorCode: responseErrorCode(error) });
      throw error;
    }
  };
  if (flow.provider === "twilio" || flow.provider === "development") {
    return complete({
      challengeToken: flow.challengeToken,
      provider: flow.provider,
      code,
    });
  }

  if (flow.provider !== "firebase") {
    const error = new Error("Unsupported OTP provider.");
    error.code = "OTP_PROVIDER_UNSUPPORTED";
    throw error;
  }

  let idToken;
  try {
    const credential = await flow.confirmationResult.confirm(code);
    assertCurrent(isCurrentAttempt);
    idToken = await credential.user.getIdToken();
    assertCurrent(isCurrentAttempt);
  } catch (error) {
    logOtpEvent({
      correlationId: flow.correlationId,
      stage: "complete",
      provider: "firebase",
      decision: "failed",
      errorCode: responseErrorCode(error),
    });
    throw error;
  }
  const result = await complete({
    challengeToken: flow.challengeToken,
    provider: "firebase",
    idToken,
  });

  idToken = null;
  flow.confirmationResult = null;
  return result;
}
