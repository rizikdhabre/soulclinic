import axios from "axios";
import { classifyFirebaseSendError } from "./firebaseErrors";

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
}) {
  const challenge = await api.challenge({ phone, purpose });
  const flow = {
    challengeToken: challenge.challengeToken,
    provider: challenge.provider,
    expiresAt: challenge.expiresAt,
    retryAfterSeconds: challenge.retryAfterSeconds,
  };

  if (challenge.provider === "development") {
    return flow;
  }

  if (challenge.provider !== "firebase") {
    const error = new Error("Unsupported OTP provider.");
    error.code = "OTP_PROVIDER_UNSUPPORTED";
    throw error;
  }

  try {
    const confirmationResult = await sendFirebaseOtp(phone, containerId);
    return { ...flow, confirmationResult };
  } catch (error) {
    const classification = classifyFirebaseSendError(error);
    if (classification.action !== "fallback") {
      throw error;
    }

    clearFirebaseRecaptcha(containerId);
    const fallback = await api.fallback({
      challengeToken: challenge.challengeToken,
      firebaseErrorCode: classification.code,
    });

    return {
      challengeToken: challenge.challengeToken,
      provider: "twilio",
      expiresAt: challenge.expiresAt,
      retryAfterSeconds:
        fallback.retryAfterSeconds ?? challenge.retryAfterSeconds,
    };
  }
}

export async function completeOtpClientFlow({ flow, code, api }) {
  if (flow.provider === "twilio" || flow.provider === "development") {
    return api.complete({
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

  const credential = await flow.confirmationResult.confirm(code);
  let idToken = await credential.user.getIdToken();
  const result = await api.complete({
    challengeToken: flow.challengeToken,
    provider: "firebase",
    idToken,
  });

  idToken = null;
  flow.confirmationResult = null;
  return result;
}
