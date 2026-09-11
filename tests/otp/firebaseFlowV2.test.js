import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createOtpApiClient, startOtpClientFlow, sendOtpClientFlow, completeOtpClientFlow } from "@/lib/otp/client";

const phone = "+972521234567";
const confirmation = { confirm: vi.fn() };
const report = { code: "auth/network-request-failed", stage: "send", provenance: "firebase_sdk" };
const failure = (code, data = {}) => Object.assign(new Error("private detail"), { code, response: { data: { error: code, ...data } } });
const sdkFailure = (value = report) => Object.assign(new Error("private SDK detail"), { code: value.code, firebaseFailure: value });
function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function harness(overrides = {}) {
  const api = {
    challenge: vi.fn().mockResolvedValue({ challengeToken: "private-challenge", phone, purpose: "login", provider: "firebase", providerPolicy: "firebase_first", retryAfterSeconds: 60 }),
    firebaseSend: vi.fn(async ({ operation }) => ({ provider: "firebase", status: operation === "reserve" ? "reserved" : operation === "rejected" ? "failed" : "pending", firebaseSendId: "private-send-id", phone })),
    fallback: vi.fn().mockResolvedValue({ provider: "twilio", status: "pending" }),
    send: vi.fn().mockResolvedValue({ provider: "twilio", status: "pending" }),
    complete: vi.fn().mockResolvedValue({ success: true, purpose: "login" }),
    ...overrides,
  };
  const firebaseClient = { send: vi.fn().mockResolvedValue(confirmation), confirm: vi.fn().mockResolvedValue("private-id-token"), clearConfirmation: vi.fn(), dispose: vi.fn() };
  let flow;
  const start = (options = {}) => startOtpClientFlow({ phone, purpose: "login", api, firebaseClient, onPrepared: (value) => { flow = value; }, ...options });
  const retry = (options = {}) => sendOtpClientFlow({ flow, api, firebaseClient, ...options });
  const complete = (options = {}) => completeOtpClientFlow({ flow, api, firebaseClient, code: "654321", ...options });
  return { api, firebaseClient, start, retry, complete, flow: () => flow };
}
beforeEach(() => { vi.spyOn(console, "info").mockImplementation(() => {}); });
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers(); });

describe("Firebase-first frontend flow", () => {
  it("adds only the firebase-send and fallback endpoints to the existing API", async () => {
    const http = { post: vi.fn().mockResolvedValue({ data: { ok: true } }) };
    const api = createOtpApiClient(http);
    expect(Object.keys(api).sort()).toEqual(["challenge", "complete", "fallback", "firebaseSend", "send"]);
    for (const [method, path] of [["firebaseSend", "firebase-send"], ["fallback", "fallback"]]) {
      await expect(api[method]({ challengeToken: "private-challenge" })).resolves.toEqual({ ok: true });
      expect(http.post).toHaveBeenLastCalledWith(`/api/otp/${path}`, { challengeToken: "private-challenge" });
    }
  });
  it.each(["login", "booking"])("reserves before SDK send, acknowledges and completes %s with ID token only", async (purpose) => {
    const h = harness();
    h.firebaseClient.send.mockImplementation(async (sentPhone) => {
      expect(h.api.firebaseSend).toHaveBeenCalledExactlyOnceWith({ challengeToken: "private-challenge", operation: "reserve" });
      expect(sentPhone).toBe(phone);
      return confirmation;
    });
    await h.start({ phone: "052-123-4567", purpose });
    expect(h.flow()).toMatchObject({ provider: "firebase", providerPolicy: "firebase_first", phone, sendStatus: "sent" });
    expect(h.api.firebaseSend).toHaveBeenLastCalledWith({ challengeToken: "private-challenge", operation: "accepted", firebaseSendId: "private-send-id" });
    await h.complete();
    expect(h.firebaseClient.confirm).toHaveBeenCalledExactlyOnceWith(confirmation, "654321");
    expect(h.api.complete).toHaveBeenCalledExactlyOnceWith({ challengeToken: "private-challenge", purpose, idToken: "private-id-token" });
    expect(h.api.send).not.toHaveBeenCalled();
    expect(h.api.fallback).not.toHaveBeenCalled();
  });
  it("keeps Twilio-only completely independent of Firebase initialization", async () => {
    const h = harness();
    h.api.challenge.mockResolvedValue({ challengeToken: "private-challenge", phone, provider: "twilio", providerPolicy: "twilio_only" });
    const getFirebaseClient = vi.fn();
    await h.start({ getFirebaseClient });
    await h.complete();
    expect(getFirebaseClient).not.toHaveBeenCalled();
    expect(h.firebaseClient.send).not.toHaveBeenCalled();
    expect(h.api.send).toHaveBeenCalledTimes(1);
    expect(h.api.complete).toHaveBeenCalledWith({ challengeToken: "private-challenge", purpose: "login", code: "654321" });
  });
  it("retries a lost accepted acknowledgement without another SDK send", async () => {
    const h = harness();
    h.api.firebaseSend.mockImplementation(async ({ operation }) => {
      if (operation === "accepted" && h.api.firebaseSend.mock.calls.length === 2) throw failure("OTP_PERSISTENCE_FAILED");
      return { provider: "firebase", status: operation === "reserve" ? "reserved" : "pending", firebaseSendId: "private-send-id", phone };
    });
    await expect(h.start()).rejects.toMatchObject({ code: "OTP_PERSISTENCE_FAILED" });
    await h.retry();
    expect(h.firebaseClient.send).toHaveBeenCalledTimes(1);
    expect(h.api.firebaseSend.mock.calls.map(([p]) => p.operation)).toEqual(["reserve", "accepted", "accepted"]);
    expect(h.api.fallback).not.toHaveBeenCalled();
  });
  it.each(["sending", "pending", "failed"])("never sends SDK for replayed server status %s", async (status) => {
    const h = harness({ firebaseSend: vi.fn().mockResolvedValue({ provider: "firebase", status, phone, firebaseSendId: "private-send-id" }) });
    await expect(h.start()).rejects.toBeDefined();
    await h.retry().catch(() => {});
    expect(h.firebaseClient.send).not.toHaveBeenCalled();
    expect(h.api.fallback).not.toHaveBeenCalled();
    expect(h.api.firebaseSend).toHaveBeenLastCalledWith({ challengeToken: "private-challenge", firebaseSendId: "private-send-id", operation: "status" });
  });
  it("recovers a lost reservation via status without authorizing a second SDK send", async () => {
    const h = harness();
    h.api.firebaseSend.mockRejectedValueOnce(new Error("lost response")).mockResolvedValue({ provider: "firebase", status: "sending", firebaseSendId: "private-send-id", phone });
    await expect(h.start()).rejects.toThrow("lost response");
    await h.retry().catch(() => {});
    expect(h.api.firebaseSend).toHaveBeenLastCalledWith({ challengeToken: "private-challenge", operation: "status" });
    expect(h.firebaseClient.send).not.toHaveBeenCalled();
  });
  it("automatically falls back on an eligible settled send failure without a final error first", async () => {
    const h = harness();
    h.firebaseClient.send.mockRejectedValue(sdkFailure());
    const onStage = vi.fn();
    await h.start({ onStage });
    expect(onStage).toHaveBeenCalledWith("fallback");
    expect(h.api.fallback).toHaveBeenCalledExactlyOnceWith({ challengeToken: "private-challenge", firebaseSendId: "private-send-id", failure: report });
    expect(h.flow()).toMatchObject({ provider: "twilio", sendStatus: "sent" });
    await h.complete();
    expect(h.firebaseClient.confirm).not.toHaveBeenCalled();
    expect(h.api.complete.mock.calls[0][0]).not.toHaveProperty("idToken");
  });
  it("retains fallback report and receipt for replay, even though Twilio ownership already began", async () => {
    const h = harness();
    h.firebaseClient.send.mockRejectedValue(sdkFailure());
    h.api.fallback.mockRejectedValueOnce(failure("OTP_PERSISTENCE_FAILED", { recoveryReceipt: "private-fallback-receipt" }));
    await expect(h.start()).rejects.toMatchObject({ code: "OTP_PERSISTENCE_FAILED" });
    expect(h.flow().provider).toBe("twilio");
    await h.retry();
    expect(h.api.fallback).toHaveBeenLastCalledWith({ challengeToken: "private-challenge", firebaseSendId: "private-send-id", failure: report, recoveryReceipt: "private-fallback-receipt" });
    expect(h.firebaseClient.send).toHaveBeenCalledTimes(1);
    expect(h.api.send).not.toHaveBeenCalled();
    expect(h.api.challenge).toHaveBeenCalledTimes(1);
  });
  it.each([
    { code: "auth/invalid-phone-number", stage: "send", provenance: "firebase_sdk" },
    { code: "auth/network-request-failed", stage: "confirm", provenance: "firebase_sdk" },
    { code: "auth/network-request-failed", stage: "send", provenance: "application" },
  ])("fails closed for noneligible report %j", async (value) => {
    const h = harness();
    h.firebaseClient.send.mockRejectedValue(sdkFailure(value));
    await expect(h.start()).rejects.toBeDefined();
    expect(h.api.fallback).not.toHaveBeenCalled();
    expect(h.api.send).not.toHaveBeenCalled();
  });
  it("does not convert uncoded exceptions or reservation failures into fallback", async () => {
    const h = harness();
    h.firebaseClient.send.mockRejectedValue(new Error("uncoded"));
    await expect(h.start()).rejects.toThrow("uncoded");
    await h.retry().catch(() => {});
    expect(h.firebaseClient.send).toHaveBeenCalledTimes(1);
    expect(h.api.fallback).not.toHaveBeenCalled();
  });
  it.each(["auth/invalid-verification-code", "auth/code-expired", "auth/network-request-failed"])("keeps %s confirmation failures on Firebase", async (code) => {
    const h = harness();
    await h.start();
    h.firebaseClient.confirm.mockRejectedValue(sdkFailure({ code, stage: "confirm", provenance: "firebase_sdk" }));
    await expect(h.complete()).rejects.toBeDefined();
    expect(h.flow().provider).toBe("firebase");
    expect(h.api.fallback).not.toHaveBeenCalled();
    expect(h.api.complete).not.toHaveBeenCalled();
  });
  it("caches ID token for bounded completion retry and never confirms twice", async () => {
    const h = harness();
    await h.start();
    h.api.complete.mockRejectedValueOnce(failure("OTP_PERSISTENCE_FAILED", { recoveryReceipt: "private-complete-receipt" }));
    await expect(h.complete()).rejects.toBeDefined();
    await h.complete({ code: "000000" });
    expect(h.firebaseClient.confirm).toHaveBeenCalledTimes(1);
    expect(h.api.complete).toHaveBeenLastCalledWith({ challengeToken: "private-challenge", purpose: "login", idToken: "private-id-token", recoveryReceipt: "private-complete-receipt" });
    expect(h.flow().idToken).toBeUndefined();
  });
  it("expires cached proof after five minutes without re-confirming or sending", async () => {
    vi.useFakeTimers();
    const h = harness();
    await h.start();
    h.api.complete.mockRejectedValue(failure("OTP_PERSISTENCE_FAILED"));
    await h.complete().catch(() => {});
    vi.advanceTimersByTime(300_001);
    await expect(h.complete()).rejects.toMatchObject({ code: "OTP_VERIFICATION_EXPIRED" });
    expect(h.flow().idToken).toBeUndefined();
    expect(h.firebaseClient.confirm).toHaveBeenCalledTimes(1);
    expect(h.api.complete).toHaveBeenCalledTimes(1);
  });
  it("coalesces concurrent retries of a hanging SDK send and ignores late cancelled results", async () => {
    const h = harness();
    const pending = deferred();
    h.firebaseClient.send.mockReturnValue(pending.promise);
    let current = true;
    const options = { isCurrentAttempt: () => current };
    const start = h.start(options).catch((error) => error);
    await vi.waitFor(() => expect(h.firebaseClient.send).toHaveBeenCalledTimes(1));
    const retry = h.retry(options).catch((error) => error);
    current = false;
    pending.resolve(confirmation);
    expect(await start).toMatchObject({ code: "OTP_FLOW_CANCELLED" });
    await retry;
    expect(h.firebaseClient.send).toHaveBeenCalledTimes(1);
    expect(h.flow().confirmationResult).toBeUndefined();
    expect(h.api.firebaseSend).toHaveBeenCalledTimes(1);
    expect(h.api.fallback).not.toHaveBeenCalled();
  });
  it("never writes proof to storage or logs", async () => {
    const storage = { setItem: vi.fn() };
    vi.stubGlobal("localStorage", storage);
    vi.stubGlobal("sessionStorage", storage);
    const h = harness();
    await h.start();
    await h.complete();
    expect(storage.setItem).not.toHaveBeenCalled();
    expect(JSON.stringify(console.info.mock.calls)).not.toMatch(/private-|654321|972521234567/);
  });
  it.each(["completion", "expiry", "discard"])("evicts the adapter's private confirmation cache on %s without disposing the form", async (reason) => {
    vi.useFakeTimers();
    const h = harness();
    await h.start();
    if (reason === "completion") await h.complete();
    else if (reason === "expiry") {
      h.api.complete.mockRejectedValue(failure("OTP_PERSISTENCE_FAILED"));
      await h.complete().catch(() => {});
      vi.advanceTimersByTime(300_001);
    } else h.flow().clearProof?.();
    expect(h.firebaseClient.clearConfirmation).toHaveBeenCalledExactlyOnceWith(confirmation);
    h.flow().clearProof?.();
    expect(h.firebaseClient.clearConfirmation).toHaveBeenCalledTimes(1);
    expect(h.firebaseClient.dispose).not.toHaveBeenCalled();
    expect(h.flow().confirmationResult).toBeUndefined();
    expect(h.flow().idToken).toBeUndefined();
  });
  it("passes the real browser adapter's confirmed token through the shared completion boundary", async () => {
    const { createFirebasePhoneClient } = await import("@/lib/otp/firebaseClient");
    const host = { replaceChildren: vi.fn(), remove: vi.fn() };
    vi.stubGlobal("window", {});
    vi.stubGlobal("document", { getElementById: () => ({ isConnected: true, appendChild: vi.fn() }), createElement: () => host });
    const getIdToken = vi.fn().mockResolvedValue("private-real-adapter-id-token");
    const confirm = vi.fn().mockResolvedValue({ user: { getIdToken } });
    class RecaptchaVerifier { render() { return Promise.resolve(1); } clear() {} }
    const client = createFirebasePhoneClient({
      containerId: "integration-host",
      config: { apiKey: "mock", authDomain: "mock.invalid", projectId: "mock", appId: "mock" },
      loadSdk: async () => ({ getApps: () => [], initializeApp: () => ({}), initializeAuth: () => ({}), inMemoryPersistence: {}, RecaptchaVerifier, signInWithPhoneNumber: async () => ({ confirm }) }),
    });
    const h = harness();
    try {
      await h.start({ firebaseClient: client });
      await h.complete({ firebaseClient: client });
      expect(h.api.complete).toHaveBeenCalledExactlyOnceWith({ challengeToken: "private-challenge", purpose: "login", idToken: "private-real-adapter-id-token" });
      expect(confirm).toHaveBeenCalledTimes(1);
    } finally { client.dispose(); }
  });
  it("limits completion attempts without reconfirming or retaining expired proof", async () => {
    const h = harness();
    await h.start();
    h.api.complete.mockRejectedValue(failure("OTP_PERSISTENCE_FAILED"));
    for (let attempt = 0; attempt < 3; attempt++) await h.complete().catch(() => {});
    await expect(h.complete()).rejects.toMatchObject({ code: "OTP_VERIFICATION_EXPIRED" });
    expect(h.api.complete).toHaveBeenCalledTimes(3);
    expect(h.firebaseClient.confirm).toHaveBeenCalledTimes(1);
    expect(h.flow().idToken).toBeUndefined();
  });
  it("coalesces concurrent completions before a credential is obtained", async () => {
    const h = harness();
    await h.start();
    const pending = deferred();
    h.firebaseClient.confirm.mockReturnValue(pending.promise);
    const first = h.complete();
    const second = h.complete();
    pending.resolve("private-id-token");
    await Promise.all([first, second]);
    expect(h.firebaseClient.confirm).toHaveBeenCalledTimes(1);
    expect(h.api.complete).toHaveBeenCalledTimes(1);
  });
  it("retains supplied reservation and provider state and only reads status", async () => {
    const h = harness();
    h.api.challenge.mockResolvedValue({ phone, provider: "firebase", providerPolicy: "firebase_first", providerState: "firebase_sending", firebaseSendId: "private-send-id", challengeToken: "private-challenge" });
    let published;
    await h.start({ onPrepared: (flow) => { published = { ...flow }; } }).catch(() => {});
    expect(published).toMatchObject({ firebaseSendId: "private-send-id", providerState: "firebase_sending" });
    expect(h.api.firebaseSend).toHaveBeenCalledExactlyOnceWith({ challengeToken: "private-challenge", firebaseSendId: "private-send-id", operation: "status" });
    expect(h.firebaseClient.send).not.toHaveBeenCalled();
  });
  it("rejects an inconsistent Firebase policy before SDK send", async () => {
    const h = harness();
    h.api.challenge.mockResolvedValue({ phone, provider: "firebase", providerPolicy: "twilio_only", challengeToken: "private-challenge" });
    await expect(h.start()).rejects.toMatchObject({ code: "OTP_PROVIDER_MISMATCH" });
    expect(h.firebaseClient.send).not.toHaveBeenCalled();
    expect(h.api.fallback).not.toHaveBeenCalled();
  });
  it("never uses a mismatched reservation phone or reservation ID", async () => {
    const h = harness({ firebaseSend: vi.fn().mockResolvedValue({ provider: "firebase", status: "reserved", firebaseSendId: "private-id", phone: "+972521234568" }) });
    await expect(h.start()).rejects.toMatchObject({ code: "OTP_SEND_PENDING" });
    expect(h.firebaseClient.send).not.toHaveBeenCalled();
  });
  it("persists terminal nonfallback rejection and replays a lost rejection acknowledgement", async () => {
    const h = harness();
    const error = sdkFailure({ code: "auth/invalid-phone-number", stage: "send", provenance: "firebase_sdk" });
    h.firebaseClient.send.mockRejectedValue(error);
    h.api.firebaseSend.mockResolvedValueOnce({ provider: "firebase", status: "reserved", firebaseSendId: "private-send-id", phone }).mockRejectedValueOnce(failure("OTP_PERSISTENCE_FAILED")).mockResolvedValueOnce({ provider: "firebase", status: "sending", firebaseSendId: "private-send-id", phone });
    await h.start().catch(() => {});
    await expect(h.retry()).rejects.toBe(error);
    expect(h.flow().sendStatus).toBe("failed");
    expect(h.api.firebaseSend.mock.calls.map(([value]) => value.operation)).toEqual(["reserve", "rejected", "status", "rejected"]);
    expect(h.firebaseClient.send).toHaveBeenCalledTimes(1);
    expect(h.api.fallback).not.toHaveBeenCalled();
  });
  it("recovers an already persisted rejection through status without requiring rejection replay", async () => {
    const h = harness();
    const error = sdkFailure({ code: "auth/invalid-phone-number", stage: "send", provenance: "firebase_sdk" });
    h.firebaseClient.send.mockRejectedValue(error);
    let rejected = false;
    h.api.firebaseSend.mockImplementation(async ({ operation }) => {
      if (operation === "reserve") return { provider: "firebase", status: "reserved", firebaseSendId: "private-send-id", phone };
      if (operation === "status") return { provider: "firebase", status: "failed", firebaseSendId: "private-send-id", phone };
      if (rejected) throw failure("OTP_PROVIDER_REJECTED");
      rejected = true;
      throw failure("OTP_PERSISTENCE_FAILED");
    });
    await h.start().catch(() => {});
    await expect(h.retry()).rejects.toBe(error);
    expect(h.flow().sendStatus).toBe("failed");
    expect(h.api.firebaseSend.mock.calls.map(([value]) => value.operation)).toEqual(["reserve", "rejected", "status"]);
    expect(h.firebaseClient.send).toHaveBeenCalledTimes(1);
  });
  it("honors explicit receipt-free server restart permission on Firebase acknowledgement failure", async () => {
    const h = harness();
    h.api.firebaseSend.mockResolvedValueOnce({ provider: "firebase", status: "reserved", firebaseSendId: "private-send-id", phone }).mockRejectedValueOnce(failure("OTP_CHALLENGE_EXPIRED", { restartAllowed: true }));
    await h.start().catch(() => {});
    expect(h.flow().sendStatus).toBe("failed");
    expect(h.api.fallback).not.toHaveBeenCalled();
  });
  it("completes retained Firebase confirmation when acceptance persistence is temporarily unavailable", async () => {
    const h = harness();
    h.api.firebaseSend.mockResolvedValueOnce({ provider: "firebase", status: "reserved", firebaseSendId: "private-send-id", phone }).mockRejectedValue(failure("OTP_PERSISTENCE_FAILED"));
    await expect(h.start()).rejects.toMatchObject({ code: "OTP_PERSISTENCE_FAILED" });
    await expect(h.complete()).resolves.toMatchObject({ success: true });
    expect(h.api.firebaseSend).toHaveBeenCalledTimes(2);
    expect(h.firebaseClient.confirm).toHaveBeenCalledTimes(1);
    expect(h.api.complete).toHaveBeenCalledTimes(1);
    expect(h.api.fallback).not.toHaveBeenCalled();
  });
  it("does not relabel a fallback receipt as completion recovery when verification retries pending fallback", async () => {
    const h = harness();
    h.firebaseClient.send.mockRejectedValue(sdkFailure());
    h.api.fallback.mockRejectedValue(failure("OTP_PERSISTENCE_FAILED", { recoveryReceipt: "private-fallback-receipt" }));
    await h.start().catch(() => {});
    await h.complete().catch(() => {});
    expect(h.flow()).toMatchObject({ recoveryOperation: "fallback", recoveryReceipt: "private-fallback-receipt" });
    h.api.fallback.mockResolvedValue({ provider: "twilio", status: "pending" });
    await h.complete();
    expect(h.api.fallback).toHaveBeenLastCalledWith({ challengeToken: "private-challenge", firebaseSendId: "private-send-id", failure: report, recoveryReceipt: "private-fallback-receipt" });
    expect(h.firebaseClient.confirm).not.toHaveBeenCalled();
    expect(h.api.complete).toHaveBeenCalledExactlyOnceWith({ challengeToken: "private-challenge", purpose: "login", code: "654321" });
  });
});
