"use client";

import { useEffect, useId, useMemo, useSyncExternalStore } from "react";
import { normalizeIsraeliPhone } from "@/lib/phone";
import { getRetryDeadline, getRestrictionScope } from "@/lib/otp/retry";
import {
  completeOtpClientFlow,
  createOtpApiClient,
  startOtpClientFlow,
  sendOtpClientFlow,
} from "@/lib/otp/client";

const INITIAL_STATE = {
  phase: "idle",
  smsSent: false,
  canRetrySend: false,
  provider: null,
  loading: false,
  error: null,
  cooldownSeconds: 0,
  statusMessage: "",
};

const PUBLIC_OTP_ERROR_CODES = new Set([
  "INVALID_OTP",
  "INVALID_OTP_PURPOSE",
  "INVALID_PHONE",
  "OTP_CHALLENGE_ALREADY_COMPLETED",
  "OTP_CHALLENGE_FAILED",
  "OTP_CHALLENGE_EXPIRED",
  "OTP_COMPLETION_IN_PROGRESS",
  "OTP_FLOW_CANCELLED",
  "OTP_FLOW_NOT_STARTED",
  "OTP_LOGIN_COMPLETION_UNAVAILABLE",
  "OTP_PROVIDER_MISMATCH",
  "OTP_PROVIDER_UNSUPPORTED",
  "OTP_PROVIDER_REJECTED",
  "OTP_PROVIDER_RATE_LIMITED",
  "OTP_PURPOSE_MISMATCH",
  "OTP_PERSISTENCE_FAILED",
  "OTP_RATE_LIMIT_CONFIG_INVALID",
  "OTP_RATE_LIMITED",
  "OTP_RECOVERY_INVALID",
  "OTP_REQUEST_FAILED",
  "OTP_REQUEST_IN_PROGRESS",
  "OTP_SEND_FAILED",
  "OTP_SEND_PENDING",
  "OTP_SEND_TEMPORARY_FAILURE",
  "OTP_SEND_SOURCE_RATE_LIMITED",
  "OTP_SEND_BUDGET_EXCEEDED",
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

function normalizeCooldown(value, code) {
  if (!Number.isFinite(value) || value <= 0) return 0;
  return Math.min(Math.ceil(value), getRestrictionScope(code) === "global" ? 86400 : 3600);
}

function safeErrorCode(value) {
  return PUBLIC_OTP_ERROR_CODES.has(value)
    ? value
    : null;
}

function projectError(error, operation) {
  const response = error?.response?.data;
  const responseCode =
    typeof response?.error === "string"
      ? response.error
      : response?.error?.code;
  const firebaseCode = error?.firebaseFailure?.code || error?.code;
  const firebasePublicCode = {
    "auth/invalid-phone-number": "INVALID_PHONE",
    "auth/missing-phone-number": "INVALID_PHONE",
    "auth/invalid-verification-code": "INVALID_OTP",
    "auth/missing-verification-code": "OTP_VERIFICATION_REQUIRED",
    "auth/code-expired": "OTP_VERIFICATION_EXPIRED",
    "auth/session-expired": "OTP_VERIFICATION_EXPIRED",
    "auth/too-many-requests": operation === "verify" ? "OTP_VERIFY_RATE_LIMITED" : "OTP_PROVIDER_RATE_LIMITED",
    "auth/quota-exceeded": "OTP_PROVIDER_RATE_LIMITED",
    "auth/network-request-failed": operation === "verify" ? "OTP_VERIFY_TEMPORARY_FAILURE" : "OTP_SEND_TEMPORARY_FAILURE",
    "auth/timeout": operation === "verify" ? "OTP_VERIFY_TEMPORARY_FAILURE" : "OTP_SEND_TEMPORARY_FAILURE",
    "auth/internal-error": operation === "verify" ? "OTP_VERIFY_TEMPORARY_FAILURE" : "OTP_SEND_TEMPORARY_FAILURE",
    "auth/unauthorized-domain": "OTP_SERVICE_NOT_CONFIGURED",
    "auth/operation-not-allowed": "OTP_SERVICE_NOT_CONFIGURED",
    "auth/invalid-api-key": "OTP_SERVICE_NOT_CONFIGURED",
    "auth/captcha-check-failed": "OTP_SEND_TEMPORARY_FAILURE",
    "client/configuration": "OTP_SERVICE_NOT_CONFIGURED",
    "client/container-unavailable": "OTP_SEND_TEMPORARY_FAILURE",
  }[firebaseCode];
  const code =
    safeErrorCode(responseCode) ||
    safeErrorCode(error?.code) ||
    safeErrorCode(firebasePublicCode) ||
    "OTP_REQUEST_FAILED";
  const retryAfterSeconds = normalizeCooldown(
    error?.retryAfterSeconds ?? response?.retryAfterSeconds,
    code,
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
  api = defaultApi,
  startFlow = startOtpClientFlow,
  sendFlow = sendOtpClientFlow,
  completeFlow = completeOtpClientFlow,
  schedule = setTimeout,
  cancel = clearTimeout,
  now = () => Date.now(),
  flowRef = { current: null },
  inFlightRef = { current: false },
  containerId,
  firebaseClient,
  loadFirebaseClient = () => import("@/lib/otp/firebaseClient"),
}) {
  let state = { ...INITIAL_STATE };
  let currentPhone = null;
  const phoneDeadlines = new Map();
  let sourceRestriction = null;
  let version = 0;
  let disposed = false;
  let activeOperation = null;
  let cooldownTimer = null;
  let sendWatchdog = null;
  let browserClient = null;
  let browserClientPromise = null;
  const listeners = new Set();

  async function getFirebaseClient() {
    if (browserClient) return browserClient;
    if (firebaseClient) {
      browserClient = firebaseClient;
      return browserClient;
    }
    if (!browserClientPromise) {
      const clientVersion = version;
      browserClientPromise = loadFirebaseClient().then((module) => {
        if (disposed || clientVersion !== version) throw createFlowCancelledError();
        browserClient = module.createFirebasePhoneClient({ containerId });
        return browserClient;
      }).finally(() => { browserClientPromise = null; });
    }
    return browserClientPromise;
  }

  function discardFlow() {
    const flow = flowRef.current;
    if (flow) {
      flow.clearProof?.();
      for (const key of ["idToken", "confirmationResult", "recoveryReceipt", "fallbackFailure", "rejectedFailure", "rejectionError"]) delete flow[key];
    }
    flowRef.current = null;
  }

  function stopSendWatchdog() {
    if (sendWatchdog !== null) cancel(sendWatchdog);
    sendWatchdog = null;
  }

  function getSnapshot() {
    return state;
  }

  function subscribe(listener) {
    listeners.add(listener);
    return () => listeners.delete(listener);
  }

  function updateState(patch) {
    if (disposed) return;
    state = {
      ...state,
      ...patch,
      canRetrySend: flowRef.current?.sendStatus === "prepared",
    };
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
    const scope = getRestrictionScope(error?.code);
    const deadline = getRetryDeadline({ ...value, restrictionScope: scope }, now());
    if (deadline > now()) {
      if (scope === "source" || scope === "global") {
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
    currentPhone = phone;
    version += 1;
    discardFlow();
    stopSendWatchdog();
    updateState({ ...INITIAL_STATE, loading: inFlightRef.current, error: sourceRestriction?.error || null });
    refreshCooldown();
    return true;
  }

  async function runStart(phone) {
    if (disposed) return { started: false, reason: "inactive" };
    setPhone(phone);
    if (inFlightRef.current) return { started: false, reason: "in-flight" };
    const preparedFlow = flowRef.current?.sendStatus === "prepared" ? flowRef.current : null;
    refreshCooldown();
    if (state.cooldownSeconds > 0 && !preparedFlow) {
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
    let reservationObserved = Boolean(preparedFlow);
    if (!preparedFlow) discardFlow();
    updateState({
      phase: "sending",
      provider: preparedFlow?.provider || null,
      smsSent: false,
      loading: true,
      error: null,
      statusMessage: "جارٍ إرسال رمز التحقق…",
    });
    const onStage = (stage) => {
      if (!isCurrentAttempt()) return;
      if (stage === "fallback") {
        stopSendWatchdog();
        updateState({ provider: "twilio", statusMessage: "جارٍ محاولة إرسال الرمز عبر الخدمة البديلة…", error: null });
      } else if (stage?.status === "pending") {
        updateState({ statusMessage: "لا يزال إرسال الرمز قيد الانتظار. يرجى الانتظار…" });
      }
    };
    const watchFirebase = (flow) => {
      if (flow.provider !== "firebase") return;
      stopSendWatchdog();
      sendWatchdog = schedule(() => {
        sendWatchdog = null;
        if (isCurrentAttempt()) onStage({ status: "pending" });
      }, 20_000);
    };
    if (preparedFlow) watchFirebase(preparedFlow);

    try {
      const nextFlow = preparedFlow
        ? await sendFlow({ flow: preparedFlow, api, getFirebaseClient, onStage, isCurrentAttempt })
        : await startFlow({
          phone,
          purpose,
          api,
          getFirebaseClient,
          onStage,
          isCurrentAttempt,
          onChallenge: (reservation) => {
            reservationObserved = true;
            rememberRestriction(phone, reservation);
          },
          onPrepared: (flow) => {
            if (isCurrentAttempt()) {
              flowRef.current = flow;
              watchFirebase(flow);
              updateState({ provider: flow.provider });
            }
          },
        });

      if (!isCurrentAttempt()) return { started: false, reason: "cancelled" };

      flowRef.current = nextFlow;
      if (!reservationObserved) rememberRestriction(phone, nextFlow);
      if (nextFlow.sendRetry) rememberRestriction(phone, nextFlow.sendRetry);
      else if (reservationObserved) refreshCooldown();
      updateState({
        phase: "code",
        provider: nextFlow.provider,
        smsSent: true,
        loading: false,
        error: null,
        statusMessage: "",
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
      if (!isCurrentAttempt()) return { started: false, reason: "cancelled" };
      // Firebase's ConfirmationResult proves send acceptance even if our acknowledgement failed.
      const acceptedFirebaseSend = flowRef.current?.provider === "firebase" &&
        flowRef.current.sendStatus === "prepared" &&
        Boolean(flowRef.current.confirmationResult) && !flowRef.current.fallbackPending;
      updateState({
        phase: acceptedFirebaseSend ? "code" : flowRef.current?.sendStatus === "prepared" ? "send-recovery" : "idle",
        provider: flowRef.current?.provider || null,
        smsSent: acceptedFirebaseSend,
        loading: false,
        error: publicError,
        statusMessage: "",
      });
      throw error;
    } finally {
      if (activeOperation === operation) {
        stopSendWatchdog();
        activeOperation = null;
        inFlightRef.current = false;
        updateState({ loading: false });
      }
    }
  }

  async function start(phone) {
    return runStart(phone);
  }

  async function resend(phone = currentPhone) {
    if (normalizeIsraeliPhone(phone) !== currentPhone) setPhone(phone);
    if (!flowRef.current) {
      return { started: false, reason: "not-ready" };
    }
    return runStart(phone);
  }

  async function verify(code) {
    if (disposed || inFlightRef.current) return undefined;
    if (!flowRef.current || state.phase !== "code" || !state.smsSent) throw createFlowNotStartedError();

    const operation = Symbol("otp-verify");
    activeOperation = operation;
    inFlightRef.current = true;
    const operationVersion = version;
    const activeFlow = flowRef.current;
    updateState({ loading: true, error: null });

    try {
      const result = await completeFlow({ flow: activeFlow, code, api, getFirebaseClient, isCurrentAttempt: () => !disposed && operationVersion === version });
      if (disposed || operationVersion !== version) {
        throw createFlowCancelledError();
      }

      flowRef.current = null;
      stopCooldown();
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
    discardFlow();
    stopSendWatchdog();
    stopCooldown();
    updateState({ ...INITIAL_STATE, loading: inFlightRef.current, error: sourceRestriction?.error || null });
    refreshCooldown();
  }

  function dispose() {
    if (disposed) return;
    disposed = true;
    version += 1;
    activeOperation = null;
    inFlightRef.current = false;
    discardFlow();
    stopSendWatchdog();
    if (browserClient) {
      try { Promise.resolve(browserClient.dispose()).catch(() => {}); } catch { /* Cleanup cannot keep the application flow active. */ }
      browserClient = null;
    }
    currentPhone = null;
    stopCooldown();
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

export function usePhoneOtp({ purpose }) {
  const instanceId = useId();
  const recaptchaContainerId = `otp-${purpose}-${instanceId.replace(/[^a-zA-Z0-9_-]/g, "")}`;
  const controller = useMemo(
    () => createPhoneOtpController({ purpose, containerId: recaptchaContainerId }),
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
    recaptchaContainerId,
    start: controller.start,
    verify: controller.verify,
    resend: controller.resend,
    reset: controller.reset,
    setPhone: controller.setPhone,
  };
}
