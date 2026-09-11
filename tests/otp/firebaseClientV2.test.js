import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { classifyFirebaseSendFailure } from "@/lib/otp/firebaseSendPolicy";

const PHONE = "+972521234567";
const CORRELATION = "123e4567-e89b-42d3-a456-426614174000";
const config = { apiKey: "public-test-key", authDomain: "test.invalid", projectId: "test-project", appId: "test-app" };
const sdkError = (code) => Object.assign(new Error(`private ${PHONE} token secret`), { code, customData: { token: "secret" } });

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function dom() {
  const roots = new Map();
  function element() {
    return {
      childNodes: [], isConnected: true, parentNode: null,
      appendChild(child) { this.childNodes.push(child); child.parentNode = this; return child; },
      removeChild(child) { this.childNodes = this.childNodes.filter((node) => node !== child); child.parentNode = null; },
      replaceChildren() { for (const child of [...this.childNodes]) this.removeChild(child); },
      remove() { this.parentNode?.removeChild(this); },
      hasChildNodes() { return this.childNodes.length > 0; },
    };
  }
  roots.set("login-recaptcha", element());
  roots.set("booking-recaptcha", element());
  return { getElementById: (id) => roots.get(id) || null, createElement: element, roots };
}

function makeSdk() {
  const app = { name: "soulclinic-phone-otp-v2" };
  const auth = { app };
  const instances = [];
  const user = { getIdToken: vi.fn().mockResolvedValue("private-id-token") };
  const credential = { user, providerId: "phone", operationType: "signIn" };
  const confirmation = { verificationId: "private-verification-id", confirm: vi.fn().mockResolvedValue(credential) };
  const hooks = { init: vi.fn(), render: vi.fn().mockResolvedValue(1), verify: vi.fn().mockResolvedValue("private-recaptcha-token") };
  class RecaptchaVerifier {
    constructor(receivedAuth, container, parameters) {
      hooks.init();
      expect(receivedAuth).toBe(auth);
      expect(container.parentNode).not.toBeNull();
      expect(parameters.size).toBe("invisible");
      this.type = "recaptcha";
      this.container = container;
      this.parameters = parameters;
      this.clear = vi.fn();
      instances.push(this);
    }
    render() { return hooks.render(); }
    verify() { return hooks.verify(); }
  }
  const sdk = {
    getApps: vi.fn(() => []), initializeApp: vi.fn(() => app),
    initializeAuth: vi.fn(() => auth), inMemoryPersistence: { type: "NONE" },
    RecaptchaVerifier,
    signInWithPhoneNumber: vi.fn(async (receivedAuth, phone, verifier) => {
      expect(receivedAuth).toBe(auth);
      expect(phone).toBe(PHONE);
      expect(verifier).toBeInstanceOf(RecaptchaVerifier);
      await verifier.verify();
      return confirmation;
    }),
    signOut: vi.fn().mockResolvedValue(undefined),
  };
  return { sdk, loadSdk: vi.fn().mockResolvedValue(sdk), app, auth, instances, confirmation, credential, user, hooks };
}

let adapter;
let document;
let fixture;
let clients;
let diagnosticLog;
const client = (options = {}) => {
  const value = adapter.createFirebasePhoneClient({ containerId: "login-recaptcha", config, loadSdk: fixture.loadSdk, ...options });
  clients.push(value);
  return value;
};

beforeEach(async () => {
  vi.resetModules();
  adapter = await import("@/lib/otp/firebaseClient");
  document = dom();
  vi.stubGlobal("window", {});
  vi.stubGlobal("document", document);
  fixture = makeSdk();
  clients = [];
  diagnosticLog = vi.spyOn(console, "info").mockImplementation(() => {});
});

describe("privacy-safe Firebase diagnostic events", () => {
  const events = () => diagnosticLog.mock.calls.filter(([label]) => label === "OTP flow").map(([, event]) => event);

  it("logs SDK, Auth, verifier, send and proof milestones with the retained correlation ID", async () => {
    const value = client();
    const confirmation = await value.send(PHONE, { correlationId: CORRELATION });
    await value.confirm(confirmation, "123456");
    expect(events().map(({ stage, decision }) => [stage, decision])).toEqual([
      ["firebase_sdk_load", "started"], ["firebase_sdk_load", "success"],
      ["firebase_auth_init", "started"], ["firebase_auth_init", "success"],
      ["firebase_recaptcha_init", "started"], ["firebase_recaptcha_init", "success"],
      ["firebase_send_started", "started"],
      ["firebase_recaptcha_token", "started"], ["firebase_recaptcha_token", "success"],
      ["firebase_send_accepted", "success"],
      ["firebase_code_confirm", "started"], ["firebase_code_confirm", "success"],
      ["firebase_id_token_ready", "success"],
    ]);
    for (const event of events()) {
      expect(event).toMatchObject({ correlationId: CORRELATION, provider: "firebase", elapsedMs: expect.any(Number) });
      expect(Object.keys(event).every((key) => ["stage", "decision", "correlationId", "provider", "elapsedMs", "errorCode"].includes(key))).toBe(true);
    }
    expect(JSON.stringify(events())).not.toMatch(/private|secret|972521234567|123456/);
  });

  it.each(["auth/internal-error", "auth/network-request-failed", "auth/unknown"])("logs explicit %s send rejection without altering the wire report", async (code) => {
    fixture.sdk.signInWithPhoneNumber.mockRejectedValue(sdkError(code));
    const error = await client().send(PHONE, { correlationId: CORRELATION }).catch((error) => error);
    expect(error.firebaseFailure).toEqual({ code, stage: "send", provenance: "firebase_sdk" });
    expect(events()).toContainEqual(expect.objectContaining({ stage: "firebase_send_rejected", decision: "failed", errorCode: code, correlationId: CORRELATION }));
    expect(events().some(({ stage }) => stage === "firebase_send_accepted")).toBe(false);
    expect(JSON.stringify(events())).not.toMatch(/private|secret|972521234567/);
  });

  it("logs one live-send unknown signal and later acceptance without rejecting the promise", async () => {
    vi.useFakeTimers();
    const sending = deferred();
    const entered = deferred();
    fixture.sdk.signInWithPhoneNumber.mockImplementation(() => { entered.resolve(); return sending.promise; });
    const value = client({ watchdogMs: 20 });
    const result = value.send(PHONE, { correlationId: CORRELATION });
    await entered.promise;
    await vi.advanceTimersByTimeAsync(1000);
    const pendingEvents = events().filter(({ stage }) => stage === "firebase_send_unknown");
    sending.resolve(fixture.confirmation);
    await expect(result).resolves.toBe(fixture.confirmation);
    expect(pendingEvents).toEqual([expect.objectContaining({ decision: "blocked", errorCode: "OTP_SEND_PENDING", correlationId: CORRELATION })]);
    expect(events().filter(({ stage }) => stage === "firebase_send_accepted")).toHaveLength(1);
    expect(events().some(({ stage }) => stage === "firebase_send_rejected")).toBe(false);
  });

  it.each([["load", "firebase_sdk_load"], ["auth", "firebase_auth_init"], ["render", "firebase_recaptcha_init"], ["verify", "firebase_recaptcha_token"]])("logs bounded failures at the %s boundary", async (boundary, stage) => {
    if (boundary === "load") fixture.loadSdk.mockRejectedValue(new Error("private loader path"));
    else if (boundary === "auth") fixture.sdk.initializeAuth.mockImplementation(() => { throw sdkError("auth/internal-error"); });
    else fixture.hooks[boundary].mockRejectedValue(sdkError("auth/network-request-failed"));
    await client().send(PHONE, { correlationId: CORRELATION }).catch(() => {});
    expect(events()).toContainEqual(expect.objectContaining({ stage, decision: "failed", correlationId: CORRELATION }));
    expect(JSON.stringify(events())).not.toMatch(/private|secret|972521234567/);
  });

  it("logs token retry without repeating successful code confirmation or already cached proof", async () => {
    fixture.user.getIdToken.mockRejectedValueOnce(sdkError("auth/network-request-failed"));
    const value = client();
    const confirmation = await value.send(PHONE, { correlationId: CORRELATION });
    await value.confirm(confirmation, "123456").catch(() => {});
    await value.confirm(confirmation, "123456");
    const beforeCachedRead = events().length;
    await value.confirm(confirmation, "123456");
    expect(events()).toHaveLength(beforeCachedRead);
    expect(events().filter(({ stage }) => stage === "firebase_code_confirm").map(({ decision }) => decision)).toEqual(["started", "success"]);
    expect(events().filter(({ stage }) => stage === "firebase_id_token_ready").map(({ decision }) => decision)).toEqual(["failed", "success"]);
  });

  it("logs failed code confirmation without logging the entered code", async () => {
    fixture.confirmation.confirm.mockRejectedValue(sdkError("auth/invalid-verification-code"));
    const value = client();
    const confirmation = await value.send(PHONE, { correlationId: CORRELATION });
    await value.confirm(confirmation, "456789").catch(() => {});
    expect(events()).toContainEqual(expect.objectContaining({ stage: "firebase_code_confirm", decision: "failed", errorCode: "auth/invalid-verification-code" }));
    expect(JSON.stringify(events())).not.toMatch(/456789|private|secret|972521234567/);
    expect(events().some(({ stage }) => stage === "firebase_id_token_ready")).toBe(false);
  });

  it("bounds elapsed time and strips an unsafe correlation ID", async () => {
    let now = 1000;
    vi.spyOn(Date, "now").mockImplementation(() => now);
    fixture.hooks.render.mockImplementation(async () => { now = 1075; return 1; });
    const value = client();
    const confirmation = await value.send(PHONE, { correlationId: PHONE });
    now = 10_000_000;
    await value.confirm(confirmation, "123456");
    expect(events()).toContainEqual(expect.objectContaining({ stage: "firebase_send_accepted", elapsedMs: 75 }));
    expect(events()).toContainEqual(expect.objectContaining({ stage: "firebase_id_token_ready", elapsedMs: 3600000 }));
    expect(events().every((event) => !Object.hasOwn(event, "correlationId"))).toBe(true);
    expect(JSON.stringify(events())).not.toContain(PHONE);
  });

  it("does not let a throwing diagnostic sink change send or confirmation outcomes", async () => {
    diagnosticLog.mockImplementation(() => { throw new Error("private sink error"); });
    const value = client();
    const confirmation = await value.send(PHONE, { correlationId: CORRELATION });
    await expect(value.confirm(confirmation, "123456")).resolves.toBe("private-id-token");
    expect(diagnosticLog).toHaveBeenCalled();
  });
});

afterEach(() => {
  for (const value of clients) value.dispose();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("lazy memory-only Firebase initialization", () => {
  it("does not load Firebase on import, creation, disposal or unused logout", async () => {
    client().dispose();
    await adapter.clearFirebaseBrowserSession();
    expect(fixture.loadSdk).not.toHaveBeenCalled();
  });

  it("rejects browser operations on the server without importing the SDK", async () => {
    vi.stubGlobal("window", undefined);
    const value = client();
    await expect(value.send(PHONE)).rejects.toMatchObject({ firebaseFailure: { code: "client/browser-required", stage: "initialize", provenance: "client" } });
    expect(fixture.loadSdk).not.toHaveBeenCalled();
  });

  it("initializes a dedicated app once with only inMemoryPersistence across forms", async () => {
    const login = client();
    const booking = client({ containerId: "booking-recaptcha" });
    await Promise.all([login.send(PHONE), booking.send(PHONE)]);
    expect(fixture.loadSdk).toHaveBeenCalledTimes(1);
    expect(fixture.sdk.initializeApp).toHaveBeenCalledWith(config, "soulclinic-phone-otp-v2");
    expect(fixture.sdk.initializeAuth).toHaveBeenCalledWith(fixture.app, { persistence: fixture.sdk.inMemoryPersistence });
    expect(fixture.sdk.initializeAuth).toHaveBeenCalledTimes(1);
  });

  it("retries a failed module initialization promise", async () => {
    fixture.loadSdk.mockRejectedValueOnce(new Error("private import error"));
    const value = client();
    await expect(value.send(PHONE)).rejects.toMatchObject({ firebaseFailure: { code: "client/unclassified", stage: "initialize", provenance: "client" } });
    await expect(value.send(PHONE)).resolves.toBe(fixture.confirmation);
    expect(fixture.loadSdk).toHaveBeenCalledTimes(2);
  });

  it("retries failed Auth initialization without silently using persistent getAuth", async () => {
    fixture.sdk.initializeAuth.mockImplementationOnce(() => { throw sdkError("auth/internal-error"); });
    fixture.sdk.getApps.mockReturnValue([fixture.app]);
    const value = client();
    await expect(value.send(PHONE)).rejects.toMatchObject({ firebaseFailure: { stage: "initialize", code: "auth/internal-error", provenance: "firebase_sdk" } });
    await value.send(PHONE);
    expect(fixture.sdk.initializeAuth).toHaveBeenCalledTimes(2);
    expect(fixture.sdk.initializeApp).not.toHaveBeenCalled();
  });

  it("fails closed on missing public configuration", async () => {
    await expect(client({ config: {} }).send(PHONE)).rejects.toMatchObject({ firebaseFailure: { code: "client/configuration", stage: "initialize", provenance: "client" } });
    expect(fixture.sdk.signInWithPhoneNumber).not.toHaveBeenCalled();
  });
});

describe("verifier ownership and send lifetime", () => {
  it("uses the same owned host under a stable form container on sequential sends", async () => {
    const root = document.roots.get("login-recaptcha");
    const value = client();
    await value.send(PHONE);
    const host = fixture.instances[0].container;
    await value.send(PHONE);
    expect(fixture.instances[1].container).toBe(host);
    expect(root.childNodes).toEqual([host]);
    expect(fixture.instances[0].clear).toHaveBeenCalledTimes(1);
    expect(fixture.instances[1].clear).toHaveBeenCalledTimes(1);
    value.dispose();
    expect(root.childNodes).toEqual([]);
    expect(document.getElementById("login-recaptcha")).toBe(root);
  });

  it("requires an existing mounted form container", async () => {
    await expect(client({ containerId: "missing" }).send(PHONE)).rejects.toMatchObject({ firebaseFailure: { code: "client/container-unavailable", provenance: "client" } });
    expect(fixture.sdk.signInWithPhoneNumber).not.toHaveBeenCalled();
  });

  it("rejects duplicate sends even while initialization is pending", async () => {
    const initialization = deferred();
    fixture.loadSdk.mockReturnValue(initialization.promise);
    const value = client();
    const sending = value.send(PHONE);
    await expect(value.send(PHONE)).rejects.toMatchObject({ firebaseFailure: { code: "client/send-in-progress" } });
    initialization.resolve(fixture.sdk);
    await sending;
    expect(fixture.sdk.signInWithPhoneNumber).toHaveBeenCalledTimes(1);
  });

  it.each(["resolve", "reject"])("defers disposal and cross-instance reuse until SDK send %ss", async (outcome) => {
    const sending = deferred();
    const entered = deferred();
    fixture.sdk.signInWithPhoneNumber.mockImplementationOnce(() => { entered.resolve(); return sending.promise; });
    const first = client();
    const result = first.send(PHONE).catch((error) => error);
    await entered.promise;
    const instance = fixture.instances[0];
    first.dispose();
    first.dispose();
    expect(instance.clear).not.toHaveBeenCalled();
    expect(instance.container.parentNode).toBe(document.roots.get("login-recaptcha"));
    const remounted = client();
    await expect(remounted.send(PHONE)).rejects.toMatchObject({ firebaseFailure: { code: "client/container-busy" } });
    if (outcome === "resolve") sending.resolve(fixture.confirmation);
    else sending.reject(sdkError("auth/network-request-failed"));
    expect((await result).firebaseFailure).toMatchObject({ code: "client/cancelled", provenance: "client" });
    expect(instance.clear).toHaveBeenCalledTimes(1);
    expect(instance.container.parentNode).toBeNull();
    await expect(remounted.send(PHONE)).resolves.toBe(fixture.confirmation);
  });

  it("supports Strict Mode setup-cleanup-setup before any send", async () => {
    client().dispose();
    await expect(client().send(PHONE)).resolves.toBe(fixture.confirmation);
    expect(fixture.instances).toHaveLength(1);
  });

  it("keeps a rendering widget alive through pending disposal and never sends afterward", async () => {
    const rendering = deferred();
    const entered = deferred();
    fixture.hooks.render.mockImplementation(() => { entered.resolve(); return rendering.promise; });
    const value = client();
    const result = value.send(PHONE).catch((error) => error);
    await entered.promise;
    value.dispose();
    expect(fixture.instances[0].clear).not.toHaveBeenCalled();
    rendering.resolve(1);
    expect((await result).firebaseFailure.code).toBe("client/cancelled");
    expect(fixture.instances[0].clear).toHaveBeenCalledTimes(1);
    expect(fixture.sdk.signInWithPhoneNumber).not.toHaveBeenCalled();
  });

  it("does not start a stale attempt or expose late results", async () => {
    const isCurrentAttempt = vi.fn(() => false);
    await expect(client().send(PHONE, { isCurrentAttempt })).rejects.toMatchObject({ firebaseFailure: { code: "client/cancelled" } });
    expect(fixture.loadSdk).not.toHaveBeenCalled();
  });

  it("notifies once about a hanging send but keeps its promise, lock and widget alive", async () => {
    vi.useFakeTimers();
    const sending = deferred();
    const entered = deferred();
    fixture.sdk.signInWithPhoneNumber.mockImplementation(() => { entered.resolve(); return sending.promise; });
    const onStage = vi.fn();
    const value = client({ watchdogMs: 50 });
    let settled = false;
    const result = value.send(PHONE, { correlationId: CORRELATION, onStage }).finally(() => { settled = true; });
    await entered.promise;
    await vi.advanceTimersByTimeAsync(5000);
    const pending = onStage.mock.calls.map(([event]) => event).filter((event) => event.status === "pending");
    expect(pending).toEqual([{ stage: "send", status: "pending", correlationId: CORRELATION, firebaseFailure: { code: "client/operation-pending", stage: "send", provenance: "client" } }]);
    expect(classifyFirebaseSendFailure(pending[0].firebaseFailure).eligible).toBe(false);
    expect(settled).toBe(false);
    expect(fixture.instances[0].clear).not.toHaveBeenCalled();
    await expect(value.send(PHONE)).rejects.toMatchObject({ firebaseFailure: { code: "client/send-in-progress" } });
    sending.resolve(fixture.confirmation);
    await expect(result).resolves.toBe(fixture.confirmation);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("reports send pending after the public verifier has produced its token", async () => {
    vi.useFakeTimers();
    const sending = deferred();
    const verified = deferred();
    fixture.sdk.signInWithPhoneNumber.mockImplementation(async (_auth, _phone, verifier) => {
      await verifier.verify();
      verified.resolve();
      return sending.promise;
    });
    const onStage = vi.fn();
    const result = client({ watchdogMs: 20 }).send(PHONE, { onStage });
    await verified.promise;
    await vi.advanceTimersByTimeAsync(25);
    sending.resolve(fixture.confirmation);
    await result;
    const pending = onStage.mock.calls.map(([event]) => event).find((event) => event.status === "pending");
    expect(pending.stage).toBe("send");
  });

  it("does not send when the attempt becomes stale inside a stage observer", async () => {
    let isCurrent = true;
    const onStage = ({ stage }) => { if (stage === "send") isCurrent = false; };
    await expect(client().send(PHONE, { onStage, isCurrentAttempt: () => isCurrent })).rejects.toMatchObject({ firebaseFailure: { code: "client/cancelled" } });
    expect(fixture.sdk.signInWithPhoneNumber).not.toHaveBeenCalled();
  });

  it("sanitizes DOM ownership errors without granting technical fallback", async () => {
    document.roots.get("login-recaptcha").appendChild = () => { throw new Error("private DOM failure"); };
    const error = await client().send(PHONE).catch((error) => error);
    expect(error.firebaseFailure).toEqual({ code: "client/unclassified", stage: "recaptcha_init", provenance: "client" });
    expect(error.message).not.toContain("private");
  });
});

describe("bounded errors and diagnostics", () => {
  it.each(["auth/internal-error", "auth/network-request-failed", "auth/unknown"])("brands explicit %s send rejections", async (code) => {
    fixture.sdk.signInWithPhoneNumber.mockRejectedValue(sdkError(code));
    const onStage = vi.fn();
    const error = await client().send(PHONE, { correlationId: CORRELATION, onStage }).catch((error) => error);
    expect(error).toBeInstanceOf(Error);
    expect(error.firebaseFailure).toEqual({ code, stage: "send", provenance: "firebase_sdk" });
    expect(classifyFirebaseSendFailure(error.firebaseFailure)).toMatchObject({ eligible: true, ambiguous: true });
    expect(JSON.stringify({ error, events: onStage.mock.calls })).not.toMatch(/private|secret|972521234567/);
    expect(error.message).not.toMatch(/private|secret|972521234567/);
    expect(error.cause).toBeUndefined();
  });

  it("does not promote a code-less or forged failure into auth/unknown", async () => {
    const forged = Object.assign(new Error("network timeout"), { firebaseFailure: { code: "auth/unknown", stage: "send", provenance: "firebase_sdk" } });
    fixture.sdk.signInWithPhoneNumber.mockRejectedValue(forged);
    const error = await client().send(PHONE).catch((error) => error);
    expect(error.firebaseFailure).toEqual({ code: "client/unclassified", stage: "send", provenance: "firebase_sdk" });
    expect(classifyFirebaseSendFailure(error.firebaseFailure).eligible).toBe(false);
  });

  it.each([["init", "recaptcha_init"], ["render", "recaptcha_render"], ["verify", "recaptcha_token"]])("recognizes positively identified technical failures in %s", async (hook, stage) => {
    fixture.hooks[hook].mockImplementation(() => { throw sdkError("auth/network-request-failed"); });
    const error = await client().send(PHONE).catch((error) => error);
    expect(error.firebaseFailure).toEqual({ code: "recaptcha/network-request-failed", stage, provenance: "recaptcha_sdk" });
    expect(classifyFirebaseSendFailure(error.firebaseFailure)).toMatchObject({ eligible: true, ambiguous: false });
    if (hook !== "init") expect(fixture.instances[0].clear).toHaveBeenCalledTimes(1);
  });

  it.each(["auth/captcha-check-failed", "auth/invalid-app-credential", "auth/recaptcha-not-enabled", undefined])("does not infer technical evidence from reCAPTCHA failure %s", async (code) => {
    fixture.hooks.render.mockRejectedValue(sdkError(code));
    const error = await client().send(PHONE).catch((error) => error);
    expect(classifyFirebaseSendFailure(error.firebaseFailure).eligible).toBe(false);
    expect(error.firebaseFailure.code).toBe(code || "client/unclassified");
  });

  it("ignores throwing observers and excludes unsafe correlation IDs", async () => {
    const onStage = vi.fn(() => { throw sdkError("auth/unknown"); });
    await expect(client().send(PHONE, { correlationId: PHONE, onStage })).resolves.toBe(fixture.confirmation);
    expect(JSON.stringify(onStage.mock.calls)).not.toContain(PHONE);
  });

  it("does not let verifier cleanup failure mask successful delivery", async () => {
    fixture.sdk.signInWithPhoneNumber.mockImplementation(async () => {
      fixture.instances[0].clear.mockImplementation(() => { throw new Error("cleanup private"); });
      return fixture.confirmation;
    });
    await expect(client().send(PHONE)).resolves.toBe(fixture.confirmation);
  });
});

describe("confirmation proof retry and sign-out", () => {
  it("expires a confirmed credential before ten token retries an hour later", async () => {
    vi.useFakeTimers();
    fixture.user.getIdToken.mockRejectedValue(sdkError("auth/network-request-failed"));
    const value = client();
    const confirmation = await value.send(PHONE);
    await value.confirm(confirmation, "123456").catch(() => {});
    await vi.advanceTimersByTimeAsync(3600000);
    const errors = [];
    for (let attempt = 0; attempt < 10; attempt += 1) {
      errors.push(await value.confirm(confirmation, "654321").catch((error) => error));
    }
    expect(errors.map((error) => error.firebaseFailure)).toEqual(Array.from({ length: 10 }, () => ({
      code: "auth/code-expired", stage: "token", provenance: "client",
    })));
    expect(fixture.confirmation.confirm).toHaveBeenCalledTimes(1);
    expect(fixture.user.getIdToken).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("does not extend credential retention when token acquisition eventually succeeds", async () => {
    vi.useFakeTimers();
    fixture.user.getIdToken.mockRejectedValueOnce(sdkError("auth/network-request-failed"));
    const value = client();
    const confirmation = await value.send(PHONE);
    await value.confirm(confirmation, "123456").catch(() => {});
    await vi.advanceTimersByTimeAsync(299999);
    await expect(value.confirm(confirmation, "123456")).resolves.toBe("private-id-token");
    await vi.advanceTimersByTimeAsync(1);
    const error = await value.confirm(confirmation, "123456").catch((error) => error);
    expect(error.firebaseFailure).toEqual({ code: "auth/code-expired", stage: "token", provenance: "client" });
    expect(classifyFirebaseSendFailure(error.firebaseFailure).eligible).toBe(false);
    expect(fixture.confirmation.confirm).toHaveBeenCalledTimes(1);
    expect(fixture.user.getIdToken).toHaveBeenCalledTimes(2);
  });

  it("starts the five-minute deadline at successful confirmation, not SMS send", async () => {
    vi.useFakeTimers();
    fixture.user.getIdToken.mockRejectedValue(sdkError("auth/network-request-failed"));
    const value = client();
    const confirmation = await value.send(PHONE);
    await vi.advanceTimersByTimeAsync(600000);
    await expect(value.confirm(confirmation, "123456")).rejects.toHaveProperty("code", "auth/network-request-failed");
    await vi.advanceTimersByTimeAsync(299999);
    await expect(value.confirm(confirmation, "123456")).rejects.toHaveProperty("code", "auth/network-request-failed");
    await vi.advanceTimersByTimeAsync(1);
    await expect(value.confirm(confirmation, "123456")).rejects.toHaveProperty("code", "auth/code-expired");
    expect(fixture.confirmation.confirm).toHaveBeenCalledTimes(1);
    expect(fixture.user.getIdToken).toHaveBeenCalledTimes(2);
  });

  it("allows at most three token reads, then permanently expires that confirmation", async () => {
    vi.useFakeTimers();
    fixture.user.getIdToken.mockRejectedValue(sdkError("auth/network-request-failed"));
    const value = client();
    const confirmation = await value.send(PHONE);
    for (let attempt = 0; attempt < 2; attempt += 1) {
      await expect(value.confirm(confirmation, "123456")).rejects.toHaveProperty("code", "auth/network-request-failed");
    }
    await expect(value.confirm(confirmation, "123456")).rejects.toHaveProperty("code", "auth/code-expired");
    for (let attempt = 0; attempt < 10; attempt += 1) {
      await expect(value.confirm(confirmation, "123456")).rejects.toHaveProperty("code", "auth/code-expired");
    }
    expect(fixture.confirmation.confirm).toHaveBeenCalledTimes(1);
    expect(fixture.user.getIdToken).toHaveBeenCalledTimes(3);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("enforces the deadline even when a background-tab timer has not fired", async () => {
    vi.useFakeTimers();
    fixture.user.getIdToken.mockRejectedValue(sdkError("auth/network-request-failed"));
    const value = client();
    const confirmation = await value.send(PHONE);
    await value.confirm(confirmation, "123456").catch(() => {});
    vi.setSystemTime(Date.now() + 300000);
    await expect(value.confirm(confirmation, "123456")).rejects.toHaveProperty("code", "auth/code-expired");
    expect(fixture.user.getIdToken).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("rejects late token proof after expiry without starting another confirmation", async () => {
    vi.useFakeTimers();
    const token = deferred();
    const entered = deferred();
    fixture.user.getIdToken.mockImplementation(() => { entered.resolve(); return token.promise; });
    const value = client();
    const confirmation = await value.send(PHONE);
    const result = value.confirm(confirmation, "123456").catch((error) => error);
    await entered.promise;
    await vi.advanceTimersByTimeAsync(300000);
    token.resolve("private-late-token");
    const error = await result;
    expect(error.firebaseFailure).toEqual({ code: "auth/code-expired", stage: "token", provenance: "client" });
    await expect(value.confirm(confirmation, "123456")).rejects.toHaveProperty("code", "auth/code-expired");
    expect(fixture.confirmation.confirm).toHaveBeenCalledTimes(1);
    expect(fixture.user.getIdToken).toHaveBeenCalledTimes(1);
    expect(diagnosticLog.mock.calls.some(([, event]) => event?.stage === "firebase_id_token_ready" && event.decision === "success")).toBe(false);
  });

  it.each(["clear", "dispose", "logout"])("removes the credential-retention timer on %s", async (action) => {
    vi.useFakeTimers();
    fixture.user.getIdToken.mockRejectedValue(sdkError("auth/network-request-failed"));
    const value = client();
    const confirmation = await value.send(PHONE);
    await value.confirm(confirmation, "123456").catch(() => {});
    expect(vi.getTimerCount()).toBe(1);
    if (action === "clear") value.clearConfirmation(confirmation);
    else if (action === "dispose") value.dispose();
    else await adapter.clearFirebaseBrowserSession();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("caches a successful credential before retrying getIdToken, then reuses proof", async () => {
    const value = client();
    const confirmation = await value.send(PHONE);
    fixture.user.getIdToken.mockRejectedValueOnce(sdkError("auth/network-request-failed"));
    const error = await value.confirm(confirmation, "123456").catch((error) => error);
    expect(error.firebaseFailure).toEqual({ code: "auth/network-request-failed", stage: "token", provenance: "firebase_sdk" });
    expect(classifyFirebaseSendFailure(error.firebaseFailure).eligible).toBe(false);
    const proof = await value.confirm(confirmation, "123456");
    expect(proof).toBe("private-id-token");
    expect(await value.confirm(confirmation, "654321")).toBe(proof);
    expect(fixture.confirmation.confirm).toHaveBeenCalledTimes(1);
    expect(fixture.user.getIdToken).toHaveBeenCalledTimes(2);
  });

  it("coalesces concurrent confirmation and token reads", async () => {
    const confirming = deferred();
    fixture.confirmation.confirm.mockReturnValue(confirming.promise);
    const value = client();
    const confirmation = await value.send(PHONE);
    const first = value.confirm(confirmation, "123456");
    const second = value.confirm(confirmation, "123456");
    confirming.resolve(fixture.credential);
    const [a, b] = await Promise.all([first, second]);
    expect(a).toBe(b);
    expect(fixture.confirmation.confirm).toHaveBeenCalledTimes(1);
    expect(fixture.user.getIdToken).toHaveBeenCalledTimes(1);
  });

  it.each(["auth/invalid-verification-code", "auth/code-expired", "auth/network-request-failed"])("keeps %s confirmation failures out of send fallback and permits a new code", async (code) => {
    fixture.confirmation.confirm.mockRejectedValueOnce(sdkError(code));
    const value = client();
    const confirmation = await value.send(PHONE);
    const error = await value.confirm(confirmation, "bad").catch((error) => error);
    expect(error.firebaseFailure.stage).toBe("confirm");
    expect(classifyFirebaseSendFailure(error.firebaseFailure).eligible).toBe(false);
    await value.confirm(confirmation, "123456");
    expect(fixture.confirmation.confirm).toHaveBeenCalledTimes(2);
  });

  it("rejects confirmations not returned by this client", async () => {
    await expect(client().confirm(fixture.confirmation, "123456")).rejects.toMatchObject({ firebaseFailure: { code: "client/invalid-confirmation" } });
    expect(fixture.confirmation.confirm).not.toHaveBeenCalled();
  });

  it("does not cache or return empty proof tokens", async () => {
    fixture.user.getIdToken.mockResolvedValueOnce("");
    const value = client();
    const confirmation = await value.send(PHONE);
    await expect(value.confirm(confirmation, "123456")).rejects.toMatchObject({ firebaseFailure: { code: "client/invalid-proof", stage: "token" } });
    await expect(value.confirm(confirmation, "123456")).resolves.toBe("private-id-token");
    expect(fixture.confirmation.confirm).toHaveBeenCalledTimes(1);
  });

  it("evicts completed proof without disposing the form client", async () => {
    const value = client();
    const confirmation = await value.send(PHONE);
    await value.confirm(confirmation, "123456");
    value.clearConfirmation(confirmation);
    value.clearConfirmation(confirmation);
    await expect(value.confirm(confirmation, "123456")).rejects.toMatchObject({ firebaseFailure: { code: "client/invalid-confirmation" } });
    expect(fixture.confirmation.confirm).toHaveBeenCalledTimes(1);
    expect(fixture.user.getIdToken).toHaveBeenCalledTimes(1);
    await expect(value.send(PHONE)).resolves.toBe(fixture.confirmation);
  });

  it("does not expose or retain a pending proof after explicit confirmation cleanup", async () => {
    const token = deferred();
    const entered = deferred();
    fixture.user.getIdToken.mockImplementation(() => { entered.resolve(); return token.promise; });
    const value = client();
    const confirmation = await value.send(PHONE);
    const result = value.confirm(confirmation, "123456").catch((error) => error);
    await entered.promise;
    if (value.clearConfirmation) value.clearConfirmation(confirmation);
    token.resolve("private-id-token");
    expect((await result).firebaseFailure).toMatchObject({ code: "client/cancelled" });
    await expect(value.confirm(confirmation, "123456")).rejects.toMatchObject({ firebaseFailure: { code: "client/invalid-confirmation" } });
  });

  it("clears initialized Firebase Auth on logout and invalidates cached proof", async () => {
    const value = client();
    const confirmation = await value.send(PHONE);
    await value.confirm(confirmation, "123456");
    await adapter.clearFirebaseBrowserSession();
    expect(fixture.sdk.signOut).toHaveBeenCalledWith(fixture.auth);
    await expect(value.confirm(confirmation, "123456")).rejects.toMatchObject({ firebaseFailure: { code: "client/cancelled" } });
  });

  it("releases idle verifier ownership on logout so a new client can use the form", async () => {
    await client().send(PHONE);
    await adapter.clearFirebaseBrowserSession();
    expect(document.roots.get("login-recaptcha").childNodes).toHaveLength(0);
    await expect(client().send(PHONE)).resolves.toBe(fixture.confirmation);
  });

  it("waits for a pending confirmation before final sign-out, without exposing its proof", async () => {
    const confirming = deferred();
    const entered = deferred();
    fixture.confirmation.confirm.mockImplementation(() => { entered.resolve(); return confirming.promise; });
    const value = client();
    const confirmation = await value.send(PHONE);
    const result = value.confirm(confirmation, "123456").catch((error) => error);
    await entered.promise;
    const logout = adapter.clearFirebaseBrowserSession();
    confirming.resolve(fixture.credential);
    expect((await result).firebaseFailure.code).toBe("client/cancelled");
    await logout;
    expect(fixture.sdk.signOut).toHaveBeenCalledWith(fixture.auth);
    expect(fixture.user.getIdToken).not.toHaveBeenCalled();
  });

  it("signs out immediately even if confirmation is hanging, then clears late sign-in", async () => {
    const confirming = deferred();
    const entered = deferred();
    fixture.confirmation.confirm.mockImplementation(() => { entered.resolve(); return confirming.promise; });
    const value = client();
    const confirmation = await value.send(PHONE);
    const result = value.confirm(confirmation, "123456").catch((error) => error);
    await entered.promise;
    const logout = adapter.clearFirebaseBrowserSession();
    await Promise.resolve();
    await Promise.resolve();
    const immediateSignOuts = fixture.sdk.signOut.mock.calls.length;
    confirming.resolve(fixture.credential);
    await Promise.all([result, logout]);
    expect(immediateSignOuts).toBe(1);
    expect(fixture.sdk.signOut).toHaveBeenCalledTimes(2);
  });

  it("returns a safe error on logout failure and allows retry", async () => {
    await client().send(PHONE);
    fixture.sdk.signOut.mockRejectedValueOnce(sdkError("auth/network-request-failed"));
    await expect(adapter.clearFirebaseBrowserSession()).rejects.toMatchObject({ firebaseFailure: { code: "auth/network-request-failed", stage: "logout", provenance: "firebase_sdk" } });
    await adapter.clearFirebaseBrowserSession();
    expect(fixture.sdk.signOut).toHaveBeenCalledTimes(2);
  });
});
