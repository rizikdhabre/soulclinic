import { isOtpCorrelationId, logOtpEvent } from "./diagnostics";
import { FIREBASE_FAILURE_CODES } from "./firebaseSendPolicy";

const APP_NAME = "soulclinic-phone-otp-v2";
const CONFIRMATION_RETENTION_MS = 300000;
const MAX_TOKEN_ATTEMPTS = 3;
const failureCodes = new Set(FIREBASE_FAILURE_CODES);
const brandedErrors = new WeakSet();
const containerOwners = new WeakMap();
const runtimes = new Map();
const activeConfirmations = new Set();
const activeClients = new Set();
let sessionGeneration = 0;

async function loadFirebaseSdk() {
  const app = await import("firebase/app");
  const auth = await import("firebase/auth");
  return { ...app, ...auth };
}

function browserConfig() {
  return {
    apiKey: process.env.NEXT_PUBLIC_FIREBASE_API_KEY,
    authDomain: process.env.NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN,
    projectId: process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID,
    appId: process.env.NEXT_PUBLIC_FIREBASE_APP_ID,
  };
}

function failure(code, stage, provenance = "client") {
  const safeCode = failureCodes.has(code) ? code : "client/unclassified";
  const error = new Error("Firebase phone operation failed.");
  error.name = "FirebasePhoneError";
  error.code = safeCode;
  error.firebaseFailure = Object.freeze({ code: safeCode, stage, provenance });
  brandedErrors.add(error);
  return error;
}

function sdkFailure(error, stage, provenance = "firebase_sdk") {
  if (brandedErrors.has(error)) return error;
  // Positive evidence from a specific public verifier method, never error-message matching.
  if (provenance === "firebase_sdk" && stage.startsWith("recaptcha_") &&
      (error?.code === "auth/network-request-failed" || error?.code === "auth/timeout")) {
    return failure(error.code === "auth/timeout" ? "recaptcha/timeout" : "recaptcha/network-request-failed", stage, "recaptcha_sdk");
  }
  return failure(error?.code, stage, provenance);
}

function requireBrowser() {
  if (typeof window === "undefined" || typeof document === "undefined") {
    throw failure("client/browser-required", "initialize");
  }
}

function createDiagnosticLogger(correlationId) {
  const safeCorrelationId = isOtpCorrelationId(correlationId) ? correlationId : undefined;
  const startedAt = Date.now();
  return (stage, decision, errorCode) => {
    try {
      logOtpEvent({
        correlationId: safeCorrelationId,
        provider: "firebase",
        stage,
        decision,
        errorCode,
        elapsedMs: Math.min(3600000, Math.max(0, Date.now() - startedAt)),
      });
    } catch { /* Diagnostics cannot change a provider outcome. */ }
  };
}

function initialize(loadSdk, config, diagnostic) {
  if (!["apiKey", "authDomain", "projectId", "appId"].every((key) => typeof config?.[key] === "string" && config[key].trim())) {
    diagnostic("firebase_auth_init", "failed", "OTP_SERVICE_NOT_CONFIGURED");
    throw failure("client/configuration", "initialize");
  }
  let runtime = runtimes.get(loadSdk);
  if (!runtime) {
    runtime = { promise: null };
    runtimes.set(loadSdk, runtime);
  }
  if (!runtime.promise) {
    runtime.promise = (async () => {
      let sdk;
      diagnostic("firebase_sdk_load", "started");
      try { sdk = await loadSdk(); } catch (error) {
        const safeError = sdkFailure(error, "initialize", "client");
        diagnostic("firebase_sdk_load", "failed", safeError.code);
        throw safeError;
      }
      diagnostic("firebase_sdk_load", "success");
      diagnostic("firebase_auth_init", "started");
      try {
        const app = sdk.getApps().find((candidate) => candidate.name === APP_NAME) || sdk.initializeApp(config, APP_NAME);
        const auth = sdk.initializeAuth(app, { persistence: sdk.inMemoryPersistence });
        diagnostic("firebase_auth_init", "success");
        return { sdk, auth };
      } catch (error) {
        const safeError = sdkFailure(error, "initialize");
        diagnostic("firebase_auth_init", "failed", safeError.code);
        throw safeError;
      }
    })().catch((error) => {
      runtime.promise = null;
      throw error;
    });
  }
  return runtime.promise;
}

/** Caller owns a stable, mounted container. Only this adapter's child is removed. */
export function createFirebasePhoneClient({
  containerId,
  config,
  loadSdk = loadFirebaseSdk,
  watchdogMs = 30000,
} = {}) {
  const owner = {};
  const generation = sessionGeneration;
  let disposed = false;
  let sending = false;
  let root;
  let host;
  let verifier;
  let confirmations = new WeakMap();
  const expiredConfirmations = new WeakSet();
  const retainedStates = new Set();

  function current(isCurrentAttempt = () => true) {
    if (disposed || generation !== sessionGeneration) return false;
    try { return isCurrentAttempt() === true; } catch { return false; }
  }

  function assertCurrent(isCurrentAttempt) {
    if (!current(isCurrentAttempt)) throw failure("client/cancelled", "lifecycle");
  }

  function releaseProofState(state) {
    clearTimeout(state.retentionTimer);
    state.retentionTimer = undefined;
    state.credential = null;
    state.proof = null;
    retainedStates.delete(state);
  }

  function expireConfirmation(confirmation, state) {
    if (confirmations.get(confirmation) !== state) return;
    releaseProofState(state);
    confirmations.delete(confirmation);
    // A weak tombstone prevents expiry from becoming a fresh confirmation attempt.
    expiredConfirmations.add(confirmation);
    state.diagnostic("firebase_id_token_ready", "failed", "auth/code-expired");
  }

  function assertUnexpired(confirmation, state) {
    if (state?.expiresAt != null && Date.now() >= state.expiresAt) expireConfirmation(confirmation, state);
    if (expiredConfirmations.has(confirmation)) throw failure("auth/code-expired", "token");
  }

  function acquireContainer() {
    const container = typeof containerId === "string" && document.getElementById(containerId);
    if (!container || container.isConnected === false || (root && root !== container)) {
      throw failure("client/container-unavailable", "recaptcha_init");
    }
    const existing = containerOwners.get(container);
    if (existing && existing !== owner) throw failure("client/container-busy", "recaptcha_init");
    containerOwners.set(container, owner);
    root = container;
    if (!host) {
      host = document.createElement("div");
      root.appendChild(host);
    }
  }

  function cleanupVerifier() {
    const previous = verifier;
    verifier = undefined;
    // Cleanup is best effort and can never change an SDK send outcome.
    try { previous?.clear(); } catch { /* No raw SDK errors in diagnostics. */ }
    try { host?.replaceChildren(); } catch { /* Parent still belongs to the form. */ }
  }

  function releaseContainer() {
    try { host?.remove(); } catch { /* Detached form. */ }
    if (root && containerOwners.get(root) === owner) containerOwners.delete(root);
    host = undefined;
    root = undefined;
  }

  async function send(phone, { correlationId, onStage, isCurrentAttempt = () => true } = {}) {
    requireBrowser();
    assertCurrent(isCurrentAttempt);
    if (sending) throw failure("client/send-in-progress", "send");
    try { acquireContainer(); } catch (error) {
      releaseContainer();
      throw sdkFailure(error, "recaptcha_init", "client");
    }
    sending = true;
    let stage = "initialize";
    let watchdog;
    const diagnostic = createDiagnosticLogger(correlationId);

    function notify(status, firebaseFailure) {
      if (!current(isCurrentAttempt) || typeof onStage !== "function") return;
      const event = { stage, status };
      if (isOtpCorrelationId(correlationId)) event.correlationId = correlationId;
      if (firebaseFailure) event.firebaseFailure = firebaseFailure;
      try { onStage(event); } catch { /* Observers cannot affect provider operations. */ }
    }

    function enter(nextStage) {
      stage = nextStage;
      notify("started");
    }

    try {
      enter("initialize");
      const delay = Number.isFinite(watchdogMs) ? Math.max(1, Math.min(watchdogMs, 120000)) : 30000;
      // Notification only: never race, reject, cancel, unlock or dispose a live operation.
      watchdog = setTimeout(() => {
        diagnostic("firebase_send_unknown", "blocked", "OTP_SEND_PENDING");
        notify("pending", failure("client/operation-pending", stage).firebaseFailure);
      }, delay);
      assertCurrent(isCurrentAttempt);
      const { sdk, auth } = await initialize(loadSdk, config ?? browserConfig(), diagnostic);
      assertCurrent(isCurrentAttempt);
      enter("recaptcha_init");
      assertCurrent(isCurrentAttempt);
      diagnostic("firebase_recaptcha_init", "started");
      class ObservedRecaptchaVerifier extends sdk.RecaptchaVerifier {
        async verify() {
          enter("recaptcha_token");
          diagnostic("firebase_recaptcha_token", "started");
          let token;
          try { token = await super.verify(); } catch (error) {
            const safeError = sdkFailure(error, "recaptcha_token");
            diagnostic("firebase_recaptcha_token", "failed", safeError.code);
            throw safeError;
          }
          diagnostic("firebase_recaptcha_token", "success");
          enter("send");
          return token;
        }
      }
      // A real RecaptchaVerifier subclass retains SDK lifecycle behavior; no private API access.
      verifier = new ObservedRecaptchaVerifier(auth, host, { size: "invisible" });
      enter("recaptcha_render");
      assertCurrent(isCurrentAttempt);
      await verifier.render();
      assertCurrent(isCurrentAttempt);
      diagnostic("firebase_recaptcha_init", "success");
      enter("send");
      assertCurrent(isCurrentAttempt);
      let confirmation;
      try {
        diagnostic("firebase_send_started", "started");
        confirmation = await sdk.signInWithPhoneNumber(auth, phone, verifier);
      } catch (error) {
        // Only this settled rejection boundary may report an ambiguous SEND failure.
        const safeError = sdkFailure(error, "send");
        diagnostic("firebase_send_rejected", "failed", safeError.code);
        throw safeError;
      }
      if (!confirmation || typeof confirmation.confirm !== "function") {
        diagnostic("firebase_send_unknown", "failed", "OTP_SEND_PENDING");
        throw failure("client/invalid-confirmation", "send");
      }
      diagnostic("firebase_send_accepted", "success");
      assertCurrent(isCurrentAttempt);
      confirmations.set(confirmation, {
        credential: null, proof: null, pending: null, diagnostic, expiresAt: null, tokenAttempts: 0,
      });
      stage = "send";
      notify("success");
      return confirmation;
    } catch (error) {
      if (!current(isCurrentAttempt)) throw failure("client/cancelled", "lifecycle");
      const safeError = sdkFailure(error, stage);
      stage = safeError.firebaseFailure.stage;
      if (stage === "recaptcha_init" || stage === "recaptcha_render") {
        diagnostic("firebase_recaptcha_init", "failed", safeError.code);
      }
      notify("failed", safeError.firebaseFailure);
      throw safeError;
    } finally {
      clearTimeout(watchdog);
      sending = false;
      cleanupVerifier();
      if (disposed || generation !== sessionGeneration) releaseContainer();
    }
  }

  async function confirm(confirmation, code) {
    requireBrowser();
    assertCurrent();
    const state = confirmation && confirmations.get(confirmation);
    assertUnexpired(confirmation, state);
    if (!state) throw failure("client/invalid-confirmation", "confirm");
    if (state.proof) return state.proof;
    if (state.pending) return state.pending;

    function assertRetained() {
      assertCurrent();
      assertUnexpired(confirmation, state);
      if (confirmations.get(confirmation) !== state) throw failure("client/cancelled", "lifecycle");
    }

    const operation = (async () => {
      if (!state.credential) {
        state.diagnostic("firebase_code_confirm", "started");
        let credential;
        try { credential = await confirmation.confirm(code); } catch (error) {
          const safeError = sdkFailure(error, "confirm");
          state.diagnostic("firebase_code_confirm", "failed", safeError.code);
          throw safeError;
        }
        state.diagnostic("firebase_code_confirm", "success");
        assertRetained();
        state.credential = credential;
        state.expiresAt = Date.now() + CONFIRMATION_RETENTION_MS;
        retainedStates.add(state);
        state.retentionTimer = setTimeout(() => expireConfirmation(confirmation, state), CONFIRMATION_RETENTION_MS);
        state.retentionTimer.unref?.();
      }
      assertRetained();
      state.tokenAttempts += 1;
      try {
        const user = state.credential?.user;
        if (typeof user?.getIdToken !== "function") throw failure("client/invalid-proof", "token");
        const idToken = await user.getIdToken();
        assertRetained();
        if (typeof idToken !== "string" || !idToken.trim()) throw failure("client/invalid-proof", "token");
        state.proof = idToken;
        state.diagnostic("firebase_id_token_ready", "success");
        return state.proof;
      } catch (error) {
        const safeError = sdkFailure(error, "token");
        state.diagnostic("firebase_id_token_ready", "failed", safeError.code);
        assertRetained();
        if (state.tokenAttempts >= MAX_TOKEN_ATTEMPTS) {
          expireConfirmation(confirmation, state);
          throw failure("auth/code-expired", "token");
        }
        throw safeError;
      }
    })();
    state.pending = operation;
    activeConfirmations.add(operation);
    try {
      return await operation;
    } finally {
      state.pending = null;
      activeConfirmations.delete(operation);
    }
  }

  /** Evict private proof on completion, abandonment or expiry without unmounting the form. */
  function clearConfirmation(confirmation) {
    const state = confirmation && confirmations.get(confirmation);
    if (!state) return;
    releaseProofState(state);
    confirmations.delete(confirmation);
  }

  function dispose() {
    disposed = true;
    for (const state of retainedStates) releaseProofState(state);
    confirmations = new WeakMap();
    activeClients.delete(dispose);
    if (!sending) {
      cleanupVerifier();
      releaseContainer();
    }
  }

  activeClients.add(dispose);
  return { send, confirm, clearConfirmation, dispose };
}

/** No eager initialization. Callers can finish application logout independently. */
export async function clearFirebaseBrowserSession() {
  sessionGeneration += 1;
  for (const dispose of activeClients) dispose();
  const pending = [...activeConfirmations];
  let signOutError;
  async function signOutInitialized() {
    for (const runtime of runtimes.values()) {
      if (!runtime.promise) continue;
      let initialized;
      try { initialized = await runtime.promise; } catch { continue; }
      try { await initialized.sdk.signOut(initialized.auth); } catch (error) { signOutError = sdkFailure(error, "logout"); }
    }
  }
  await signOutInitialized();
  if (pending.length) {
    // Clear existing Auth immediately, then clear a sign-in that completed after logout.
    await Promise.allSettled(pending);
    await signOutInitialized();
  }
  if (signOutError) throw signOutError;
}
