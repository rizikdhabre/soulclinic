"use client";

import { useEffect, useMemo, useRef, useSyncExternalStore } from "react";
import { normalizeIsraeliPhone } from "@/lib/phone";
import { getRetryDeadline, getRestrictionScope } from "@/lib/otp/retry";
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
  "auth/recaptcha-not-enabled",
  "auth/missing-recaptcha-token",
  "auth/invalid-recaptcha-token",
  "auth/invalid-recaptcha-action",
  "auth/missing-client-type",
  "auth/missing-recaptcha-version",
  "auth/invalid-recaptcha-version",
  "auth/invalid-req-type",
  "auth/unauthorized-domain",
  "auth/invalid-api-key",
]);

const PUBLIC_OTP_ERROR_CODES = new Set([
  "INVALID_OTP",
  "INVALID_OTP_PURPOSE",
  "INVALID_PHONE",
  "OTP_CHALLENGE_ALREADY_COMPLETED",
  "OTP_CHALLENGE_FAILED",
  "OTP_CHALLENGE_EXPIRED",
  "OTP_COMPLETION_IN_PROGRESS",
  "OTP_FALLBACK_ALREADY_USED",
  "OTP_FALLBACK_NOT_ALLOWED",
  "OTP_FALLBACK_FAILED",
  "OTP_FALLBACK_SOURCE_RATE_LIMITED",
  "OTP_FLOW_CANCELLED",
  "OTP_FLOW_NOT_STARTED",
  "OTP_LOGIN_COMPLETION_UNAVAILABLE",
  "OTP_PROVIDER_MISMATCH",
  "OTP_PROVIDER_UNSUPPORTED",
  "OTP_PROVIDER_REJECTED",
  "OTP_PERSISTENCE_FAILED",
  "OTP_RATE_LIMIT_CONFIG_INVALID",
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
  "otp/recaptcha-setup-failed",
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
  now = () => Date.now(),
  flowRef = { current: null },
  inFlightRef = { current: false },
}) {
  let state = { ...INITIAL_STATE };
  let currentPhone = null;
  const phoneDeadlines = new Map();
  let sourceRestriction = null;
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

  function refreshCooldown() {
    stopCooldown();
    const time = now();
    for (const [phone, deadline] of phoneDeadlines) {
      if (deadline <= time) phoneDeadlines.delete(phone);
    }
    if (sourceRestriction?.deadline <= time) {
      if (state.error === sourceRestriction.error) updateState({ error: null });
      sourceRestriction = null;
    }
    const deadline = Math.max(phoneDeadlines.get(currentPhone) || 0, sourceRestriction?.deadline || 0);
    const seconds = Math.max(0, Math.ceil((deadline - time) / 1000));
    updateState({ cooldownSeconds: seconds });
    if (!seconds || disposed) return;

    cooldownTimer = schedule(() => {
      cooldownTimer = null;
      refreshCooldown();
    }, 1000);
  }

  function rememberRestriction(phone, value, error = null) {
    const deadline = getRetryDeadline(value, now());
    if (deadline > now()) {
      if (getRestrictionScope(error?.code) === "source") {
        if (!sourceRestriction || deadline >= sourceRestriction.deadline) {
          sourceRestriction = { deadline, error };
        }
        updateState({ error: sourceRestriction.error });
      } else if (phone) {
        phoneDeadlines.set(phone, Math.max(deadline, phoneDeadlines.get(phone) || 0));
      }
    }
    refreshCooldown();
    // Bound browser-only history; the authoritative server limits still apply.
    while (phoneDeadlines.size > 100) phoneDeadlines.delete(phoneDeadlines.keys().next().value);
  }

  function setPhone(value) {
    const phone = normalizeIsraeliPhone(value);
    if (phone === currentPhone) return false;
    const hadAttempt = currentPhone !== null || flowRef.current !== null;
    currentPhone = phone;
    version += 1;
    flowRef.current = null;
    if (hadAttempt) clearRecaptcha(recaptchaContainerId);
    updateState({ ...INITIAL_STATE, loading: inFlightRef.current, error: sourceRestriction?.error || null });
    refreshCooldown();
    return true;
  }

  async function runStart(phone, clearBeforeStart) {
    if (disposed) return { started: false, reason: "inactive" };
    setPhone(phone);
    if (inFlightRef.current) return { started: false, reason: "in-flight" };
    refreshCooldown();
    if (state.cooldownSeconds > 0) {
      return { started: false, reason: "cooldown" };
    }
    if (!currentPhone) {
      const error = new Error("Invalid phone number.");
      error.code = "INVALID_PHONE";
      throw error;
    }
    phone = currentPhone;

    const operation = Symbol("otp-start");
    activeOperation = operation;
    inFlightRef.current = true;
    const operationVersion = ++version;
    const isCurrentAttempt = () => !disposed && operationVersion === version;
    let reservationObserved = false;
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
        isCurrentAttempt,
        onChallenge: (reservation) => {
          reservationObserved = true;
          rememberRestriction(phone, reservation);
        },
      });

      if (disposed || operationVersion !== version) {
        if (nextFlow?.provider === "firebase") {
          clearRecaptcha(recaptchaContainerId);
        }
        return { started: false, reason: "cancelled" };
      }

      flowRef.current = nextFlow;
      if (nextFlow.provider !== "firebase") {
        clearRecaptcha(recaptchaContainerId);
      }
      if (!reservationObserved) rememberRestriction(phone, nextFlow);
      else refreshCooldown();
      updateState({
        phase: "code",
        provider: nextFlow.provider,
        loading: false,
        error: null,
      });
      return { started: true, provider: nextFlow.provider };
    } catch (error) {
      const publicError = projectError(error, "start");
      const response = error?.response?.data;
      rememberRestriction(phone, {
        retryAt: response?.retryAt ?? error?.retryAt,
        serverTime: response?.serverTime ?? error?.serverTime,
        retryAfterSeconds: publicError.retryAfterSeconds,
      }, publicError);
      if (!disposed && operationVersion === version) {
        updateState({
          phase: "idle",
          provider: null,
          loading: false,
          error: publicError,
        });
      } else return { started: false, reason: "cancelled" };
      throw error;
    } finally {
      if (activeOperation === operation) {
        activeOperation = null;
        inFlightRef.current = false;
        updateState({ loading: false });
      }
    }
  }

  async function start(phone) {
    return runStart(phone, false);
  }

  async function resend(phone = currentPhone) {
    if (normalizeIsraeliPhone(phone) !== currentPhone) setPhone(phone);
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
      const result = await completeFlow({ flow: activeFlow, code, api, isCurrentAttempt: () => !disposed && operationVersion === version });
      if (disposed || operationVersion !== version) {
        throw createFlowCancelledError();
      }

      flowRef.current = null;
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
        updateState({ loading: false });
      }
    }
  }

  function reset() {
    version += 1;
    flowRef.current = null;
    stopCooldown();
    clearRecaptcha(recaptchaContainerId);
    updateState({ ...INITIAL_STATE, loading: inFlightRef.current, error: sourceRestriction?.error || null });
    refreshCooldown();
  }

  function dispose() {
    if (disposed) return;
    disposed = true;
    version += 1;
    activeOperation = null;
    inFlightRef.current = false;
    flowRef.current = null;
    currentPhone = null;
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
    setPhone,
    refreshCooldown,
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
    const refresh = () => controller.refreshCooldown();
    globalThis.document?.addEventListener?.("visibilitychange", refresh);
    return () => {
      globalThis.document?.removeEventListener?.("visibilitychange", refresh);
      controller.dispose();
    };
  }, [controller]);

  return {
    ...state,
    start: controller.start,
    verify: controller.verify,
    resend: controller.resend,
    reset: controller.reset,
    setPhone: controller.setPhone,
  };
}
