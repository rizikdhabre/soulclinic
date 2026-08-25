"use client";

import { useEffect, useMemo, useRef, useSyncExternalStore } from "react";
import {
  clearFirebaseRecaptcha,
  sendFirebaseOtp,
} from "@/lib/phoneAuth";
import {
  completeOtpClientFlow,
  createOtpApiClient,
  startOtpClientFlow,
} from "@/lib/otp/client";

const INITIAL_STATE = {
  phase: "idle",
  provider: null,
  loading: false,
  error: null,
  cooldownSeconds: 0,
};

const PUBLIC_FIREBASE_ERROR_CODES = new Set([
  "auth/app-not-authorized",
  "auth/captcha-check-failed",
  "auth/code-expired",
  "auth/internal-error",
  "auth/invalid-app-credential",
  "auth/invalid-phone-number",
  "auth/invalid-verification-code",
  "auth/missing-app-credential",
  "auth/missing-verification-code",
  "auth/network-request-failed",
  "auth/operation-not-allowed",
  "auth/quota-exceeded",
  "auth/too-many-requests",
  "auth/unknown",
  "auth/user-disabled",
]);

const PUBLIC_OTP_ERROR_CODES = new Set([
  "INVALID_OTP",
  "INVALID_OTP_PURPOSE",
  "INVALID_PHONE",
  "OTP_CHALLENGE_ALREADY_COMPLETED",
  "OTP_CHALLENGE_FAILED",
  "OTP_COMPLETION_IN_PROGRESS",
  "OTP_FALLBACK_ALREADY_USED",
  "OTP_FALLBACK_SOURCE_RATE_LIMITED",
  "OTP_FLOW_CANCELLED",
  "OTP_FLOW_NOT_STARTED",
  "OTP_LOGIN_COMPLETION_UNAVAILABLE",
  "OTP_PROVIDER_MISMATCH",
  "OTP_PROVIDER_UNSUPPORTED",
  "OTP_RATE_LIMITED",
  "OTP_REQUEST_FAILED",
  "OTP_REQUEST_IN_PROGRESS",
  "OTP_SEND_FAILED",
  "OTP_SEND_PENDING",
  "OTP_SEND_RETRIES_EXHAUSTED",
  "OTP_SERVICE_NOT_CONFIGURED",
  "OTP_SOURCE_RATE_LIMITED",
  "OTP_SOURCE_UNAVAILABLE",
  "OTP_STATE_BUSY",
  "OTP_VERIFICATION_ALREADY_USED",
  "OTP_VERIFICATION_EXPIRED",
  "OTP_VERIFICATION_INVALID",
  "OTP_VERIFICATION_REQUIRED",
  "OTP_VERIFY_FAILED",
  "OTP_VERIFY_RATE_LIMITED",
  "OTP_VERIFY_TEMPORARY_FAILURE",
]);

const defaultApi = createOtpApiClient();

function normalizeCooldown(value) {
  if (!Number.isFinite(value) || value <= 0) return 0;
  return Math.min(Math.ceil(value), 3600);
}

function safeErrorCode(value) {
  return PUBLIC_FIREBASE_ERROR_CODES.has(value) ||
    PUBLIC_OTP_ERROR_CODES.has(value)
    ? value
    : null;
}

function projectError(error, operation) {
  const response = error?.response?.data;
  const responseCode =
    typeof response?.error === "string"
      ? response.error
      : response?.error?.code;
  const code =
    safeErrorCode(responseCode) ||
    safeErrorCode(error?.code) ||
    "OTP_REQUEST_FAILED";
  const retryAfterSeconds = normalizeCooldown(
    error?.retryAfterSeconds ?? response?.retryAfterSeconds,
  );

  return {
    code,
    message:
      operation === "verify"
        ? "Unable to verify the code."
        : "Unable to send a verification code.",
    ...(retryAfterSeconds ? { retryAfterSeconds } : {}),
  };
}

function createFlowNotStartedError() {
  const error = new Error("OTP flow has not started.");
  error.code = "OTP_FLOW_NOT_STARTED";
  return error;
}

function createFlowCancelledError() {
  const error = new Error("OTP flow was cancelled.");
  error.code = "OTP_FLOW_CANCELLED";
  return error;
}

export function createPhoneOtpController({
  purpose,
  recaptchaContainerId,
  api = defaultApi,
  startFlow = startOtpClientFlow,
  completeFlow = completeOtpClientFlow,
  sendFirebaseOtp: sendFirebase = sendFirebaseOtp,
  clearFirebaseRecaptcha: clearRecaptcha = clearFirebaseRecaptcha,
  schedule = setTimeout,
  cancel = clearTimeout,
  flowRef = { current: null },
  inFlightRef = { current: false },
}) {
  let state = { ...INITIAL_STATE };
  let lastPhone = null;
  let version = 0;
  let disposed = false;
  let activeOperation = null;
  let cooldownTimer = null;
  const listeners = new Set();

  function getSnapshot() {
    return state;
  }

  function subscribe(listener) {
    listeners.add(listener);
    return () => listeners.delete(listener);
  }

  function updateState(patch) {
    if (disposed) return;
    state = { ...state, ...patch };
    for (const listener of listeners) listener();
  }

  function stopCooldown() {
    if (cooldownTimer !== null) {
      cancel(cooldownTimer);
      cooldownTimer = null;
    }
  }

  function setCooldown(value) {
    stopCooldown();
    const seconds = normalizeCooldown(value);
    updateState({ cooldownSeconds: seconds });
    if (!seconds || disposed) return;

    cooldownTimer = schedule(() => {
      cooldownTimer = null;
      setCooldown(seconds - 1);
    }, 1000);
  }

  async function runStart(phone, clearBeforeStart) {
    if (disposed) return { started: false, reason: "inactive" };
    if (inFlightRef.current) return { started: false, reason: "in-flight" };
    if (state.cooldownSeconds > 0) {
      return { started: false, reason: "cooldown" };
    }

    const operation = Symbol("otp-start");
    activeOperation = operation;
    inFlightRef.current = true;
    const operationVersion = ++version;
    if (clearBeforeStart || flowRef.current) {
      clearRecaptcha(recaptchaContainerId);
    }
    flowRef.current = null;
    updateState({
      phase: "idle",
      provider: null,
      loading: true,
      error: null,
    });

    try {
      const nextFlow = await startFlow({
        phone,
        purpose,
        containerId: recaptchaContainerId,
        api,
        sendFirebaseOtp: sendFirebase,
        clearFirebaseRecaptcha: clearRecaptcha,
      });

      if (disposed || operationVersion !== version) {
        if (nextFlow?.provider === "firebase") {
          clearRecaptcha(recaptchaContainerId);
        }
        return { started: false, reason: "cancelled" };
      }

      flowRef.current = nextFlow;
      lastPhone = phone;
      if (nextFlow.provider !== "firebase") {
        clearRecaptcha(recaptchaContainerId);
      }
      setCooldown(nextFlow.retryAfterSeconds);
      updateState({
        phase: "code",
        provider: nextFlow.provider,
        loading: false,
        error: null,
      });
      return { started: true, provider: nextFlow.provider };
    } catch (error) {
      if (!disposed && operationVersion === version) {
        const publicError = projectError(error, "start");
        setCooldown(publicError.retryAfterSeconds);
        updateState({
          phase: "idle",
          provider: null,
          loading: false,
          error: publicError,
        });
      }
      throw error;
    } finally {
      if (activeOperation === operation) {
        activeOperation = null;
        inFlightRef.current = false;
      }
    }
  }

  async function start(phone) {
    return runStart(phone, false);
  }

  async function resend(phone = lastPhone) {
    if (state.phase !== "code" || !flowRef.current) {
      return { started: false, reason: "not-ready" };
    }
    return runStart(phone, true);
  }

  async function verify(code) {
    if (disposed || inFlightRef.current) return undefined;
    if (!flowRef.current) throw createFlowNotStartedError();

    const operation = Symbol("otp-verify");
    activeOperation = operation;
    inFlightRef.current = true;
    const operationVersion = version;
    const activeFlow = flowRef.current;
    updateState({ loading: true, error: null });

    try {
      const result = await completeFlow({ flow: activeFlow, code, api });
      if (disposed || operationVersion !== version) {
        throw createFlowCancelledError();
      }

      flowRef.current = null;
      lastPhone = null;
      stopCooldown();
      clearRecaptcha(recaptchaContainerId);
      updateState({
        phase: "complete",
        provider: activeFlow.provider,
        loading: false,
        error: null,
        cooldownSeconds: 0,
      });
      return result;
    } catch (error) {
      if (!disposed && operationVersion === version) {
        updateState({
          phase: "code",
          loading: false,
          error: projectError(error, "verify"),
        });
      }
      throw error;
    } finally {
      if (activeOperation === operation) {
        activeOperation = null;
        inFlightRef.current = false;
      }
    }
  }

  function reset() {
    version += 1;
    flowRef.current = null;
    lastPhone = null;
    stopCooldown();
    clearRecaptcha(recaptchaContainerId);
    updateState({ ...INITIAL_STATE });
  }

  function dispose() {
    if (disposed) return;
    disposed = true;
    version += 1;
    activeOperation = null;
    inFlightRef.current = false;
    flowRef.current = null;
    lastPhone = null;
    stopCooldown();
    clearRecaptcha(recaptchaContainerId);
    listeners.clear();
  }

  function activate() {
    disposed = false;
  }

  return {
    getSnapshot,
    subscribe,
    start,
    verify,
    resend,
    reset,
    activate,
    dispose,
  };
}

export function usePhoneOtp({ purpose, recaptchaContainerId }) {
  const flowRef = useRef(null);
  const inFlightRef = useRef(false);
  const controller = useMemo(
    () =>
      createPhoneOtpController({
        purpose,
        recaptchaContainerId,
        flowRef,
        inFlightRef,
      }),
    [purpose, recaptchaContainerId],
  );
  const state = useSyncExternalStore(
    controller.subscribe,
    controller.getSnapshot,
    controller.getSnapshot,
  );

  useEffect(() => {
    controller.activate();
    return () => controller.dispose();
  }, [controller]);

  return {
    ...state,
    start: controller.start,
    verify: controller.verify,
    resend: controller.resend,
    reset: controller.reset,
  };
}
