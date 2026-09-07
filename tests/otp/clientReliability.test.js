import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createPhoneOtpController } from "@/hooks/usePhoneOtp";
import { startOtpClientFlow, completeOtpClientFlow } from "@/lib/otp/client";
import { createOtpChallenge } from "@/lib/otp/challengeService";
import { createOtpRateLimitStore } from "@/lib/otp/rateLimitStore";
import { MemoryVersionedCollection } from "../helpers/memoryOtpStores";

vi.mock("@/lib/phoneAuth", () => ({
  clearFirebaseRecaptcha: vi.fn(),
  sendFirebaseOtp: vi.fn(),
}));

const PHONE_A = "+972521234567";
const PHONE_B = "+972521234568";
const failure = (code) => Object.assign(new Error("mock provider failure"), { code });
function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function harness(options = {}) {
  const clock = { now: () => new Date() };
  const rateStore = createOtpRateLimitStore({
    phoneCollection: new MemoryVersionedCollection("phone"),
    sourceCollection: new MemoryVersionedCollection("sourceHash"),
    clock,
  });
  let token = 0;
  const api = {
    challenge: vi.fn((payload) => createOtpChallenge(payload, {
      env: { NODE_ENV: "production" }, clock, rateStore,
      deriveSourceHash: () => "mock-source",
      tokenFactory: () => `mock-token-${++token}`,
      hashToken: (value) => value,
      challengeStore: { rotate: async () => ({}) },
    })),
    fallback: vi.fn().mockResolvedValue({ provider: "twilio", status: "pending" }),
    complete: vi.fn().mockResolvedValue({ success: true, purpose: "booking" }),
    ...options.api,
  };
  const sendFirebaseOtp = options.sendFirebaseOtp ?? vi.fn().mockRejectedValue(failure("auth/invalid-app-credential"));
  const controller = createPhoneOtpController({
    purpose: "booking", recaptchaContainerId: "mock-container", api,
    sendFirebaseOtp, clearFirebaseRecaptcha: vi.fn(),
  });
  return { controller, api, sendFirebaseOtp, rateStore };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-09-07T12:00:00.000Z"));
  vi.spyOn(console, "info").mockImplementation(() => {});
});
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe("OTP attempt cooldown and phone ownership", () => {
  it("retains a failed send's reservation, blocking the nine-second retry locally", async () => {
    const { controller, api, sendFirebaseOtp, rateStore } = harness({
      api: { fallback: vi.fn().mockRejectedValue(failure("OTP_SEND_FAILED")) },
    });
    await expect(controller.start(PHONE_A)).rejects.toMatchObject({ code: "OTP_SEND_FAILED" });
    expect(controller.getSnapshot()).toMatchObject({ phase: "idle", cooldownSeconds: 60, error: { code: "OTP_SEND_FAILED" } });
    await vi.advanceTimersByTimeAsync(9000);
    expect(controller.getSnapshot().cooldownSeconds).toBe(51);
    await expect(controller.start(PHONE_A)).resolves.toEqual({ started: false, reason: "cooldown" });
    await expect(rateStore.claimPhoneStart(PHONE_A)).rejects.toMatchObject({ code: "OTP_RATE_LIMITED", retryAfterSeconds: 51 });
    expect(api.challenge).toHaveBeenCalledTimes(1);
    expect(sendFirebaseOtp).toHaveBeenCalledTimes(1);
    controller.dispose();
  });

  it("reserves during sending and does not restart the deadline after a slow failure", async () => {
    const pending = deferred();
    const { controller } = harness({ sendFirebaseOtp: vi.fn(() => pending.promise) });
    const started = controller.start(PHONE_A).catch((error) => error);
    await vi.advanceTimersByTimeAsync(0);
    expect(controller.getSnapshot().cooldownSeconds).toBe(60);
    await vi.advanceTimersByTimeAsync(9000);
    pending.reject(new Error("uncoded runtime failure"));
    await started;
    expect(controller.getSnapshot()).toMatchObject({ cooldownSeconds: 51, phase: "idle" });
    controller.dispose();
  });

  it("uses elapsed time when a background tab resumes instead of counting callbacks", async () => {
    const { controller } = harness();
    await controller.start(PHONE_A);
    vi.setSystemTime(new Date("2026-09-07T12:01:10.000Z"));
    await vi.advanceTimersByTimeAsync(1000);
    expect(controller.getSnapshot().cooldownSeconds).toBe(0);
    controller.dispose();
  });

  it.each([-300_000, 300_000])("honors server time when the device clock differs by %i ms", async (skew) => {
    vi.setSystemTime(new Date(Date.parse("2026-09-07T12:00:00.000Z") + skew));
    const { controller } = harness({
      api: { challenge: vi.fn().mockResolvedValue({
        provider: "firebase", challengeToken: "mock-token",
        serverTime: "2026-09-07T12:00:00.000Z", retryAt: "2026-09-07T12:01:00.000Z",
        retryAfterSeconds: 60,
      }), fallback: vi.fn().mockRejectedValue(failure("OTP_SEND_FAILED")) },
    });
    await controller.start(PHONE_A).catch(() => {});
    expect(controller.getSnapshot().cooldownSeconds).toBe(60);
    await vi.advanceTimersByTimeAsync(9000);
    expect(controller.getSnapshot().cooldownSeconds).toBe(51);
    controller.setPhone(PHONE_B);
    controller.setPhone(PHONE_A);
    expect(controller.getSnapshot().cooldownSeconds).toBe(51);
    controller.dispose();
  });

  it("translates a source restriction using server time, not an inaccurate device clock", async () => {
    vi.setSystemTime(new Date("2026-09-07T12:05:00.000Z"));
    const { controller } = harness({ api: { challenge: vi.fn().mockRejectedValue(Object.assign(new Error("limited"), {
      response: { data: { error: "OTP_SOURCE_RATE_LIMITED", serverTime: "2026-09-07T12:00:00.000Z", retryAt: "2026-09-07T12:01:30.000Z", retryAfterSeconds: 90 } },
    })) } });
    await controller.start(PHONE_A).catch(() => {});
    controller.setPhone(PHONE_B);
    expect(controller.getSnapshot().cooldownSeconds).toBe(90);
    await vi.advanceTimersByTimeAsync(9000);
    expect(controller.getSnapshot().cooldownSeconds).toBe(81);
    controller.dispose();
  });

  it("keeps equivalent formatting, clears a different phone, and restores a prior cooldown", async () => {
    const { controller } = harness({ api: { fallback: vi.fn().mockRejectedValue(failure("OTP_SEND_FAILED")) } });
    await controller.start(PHONE_A).catch(() => {});
    expect(controller.setPhone("052-123-4567")).toBe(false);
    expect(controller.getSnapshot().error.code).toBe("OTP_SEND_FAILED");
    expect(controller.setPhone(PHONE_B)).toBe(true);
    expect(controller.getSnapshot()).toMatchObject({ error: null, provider: null, phase: "idle", cooldownSeconds: 0 });
    await vi.advanceTimersByTimeAsync(9000);
    controller.setPhone(PHONE_A);
    expect(controller.getSnapshot()).toMatchObject({ error: null, cooldownSeconds: 51 });
    controller.reset();
    expect(controller.getSnapshot().cooldownSeconds).toBe(51);
    controller.dispose();
  });

  it.each(["OTP_SOURCE_RATE_LIMITED", "OTP_FALLBACK_SOURCE_RATE_LIMITED"])("keeps %s across phone changes", async (code) => {
    const rejected = Object.assign(new Error("limited"), { response: { data: { error: code, retryAfterSeconds: 90, restrictionScope: "source" } } });
    const api = code === "OTP_SOURCE_RATE_LIMITED" ? { challenge: vi.fn().mockRejectedValue(rejected) } : { fallback: vi.fn().mockRejectedValue(rejected) };
    const { controller, api: requests } = harness({ api });
    await controller.start(PHONE_A).catch(() => {});
    controller.setPhone(PHONE_B);
    expect(controller.getSnapshot()).toMatchObject({ cooldownSeconds: 90, error: { code } });
    await expect(controller.start(PHONE_B)).resolves.toEqual({ started: false, reason: "cooldown" });
    expect(requests.challenge).toHaveBeenCalledTimes(1);
    controller.dispose();
  });

  it("does not start fallback for a stale Firebase attempt after a phone edit", async () => {
    const pending = deferred();
    const { controller, api } = harness({ sendFirebaseOtp: vi.fn(() => pending.promise) });
    const started = controller.start(PHONE_A);
    await vi.advanceTimersByTimeAsync(0);
    controller.setPhone(PHONE_B);
    pending.reject(failure("auth/network-request-failed"));
    await expect(started).resolves.toMatchObject({ started: false, reason: "cancelled" });
    expect(api.fallback).not.toHaveBeenCalled();
    expect(controller.getSnapshot()).toMatchObject({ error: null, provider: null, phase: "idle", cooldownSeconds: 0, loading: false });
    controller.setPhone(PHONE_A);
    expect(controller.getSnapshot().cooldownSeconds).toBe(60);
    controller.dispose();
  });

  it("ignores stale completion and cannot reuse another number's verification", async () => {
    const pending = deferred();
    const { controller } = harness({ api: { complete: vi.fn(() => pending.promise) } });
    await controller.start(PHONE_A);
    const verified = controller.verify("123456").catch((error) => error);
    controller.setPhone(PHONE_B);
    pending.resolve({ success: true, purpose: "booking", verificationToken: "private-grant" });
    expect(await verified).toMatchObject({ code: "OTP_FLOW_CANCELLED" });
    expect(controller.getSnapshot()).toMatchObject({ phase: "idle", provider: null, error: null });
    await expect(controller.verify("123456")).rejects.toMatchObject({ code: "OTP_FLOW_NOT_STARTED" });
    controller.dispose();
  });

  it("carries a late source-wide rejection to the newly selected phone", async () => {
    const pending = deferred();
    const { controller } = harness({ api: { challenge: vi.fn(() => pending.promise) } });
    const started = controller.start(PHONE_A);
    controller.setPhone(PHONE_B);
    pending.reject(Object.assign(new Error("limited"), { response: { data: { error: "OTP_SOURCE_RATE_LIMITED", retryAfterSeconds: 90, restrictionScope: "source" } } }));
    await started;
    expect(controller.getSnapshot()).toMatchObject({ cooldownSeconds: 90, error: { code: "OTP_SOURCE_RATE_LIMITED" } });
    controller.dispose();
  });

  it("retains a late challenge reservation for the old phone without sending or showing it on the new phone", async () => {
    const pending = deferred();
    const { controller, sendFirebaseOtp } = harness({ api: { challenge: vi.fn(() => pending.promise) } });
    const started = controller.start(PHONE_A);
    controller.setPhone(PHONE_B);
    pending.resolve({ provider: "firebase", challengeToken: "old-token", retryAfterSeconds: 60 });
    await expect(started).resolves.toMatchObject({ started: false, reason: "cancelled" });
    expect(sendFirebaseOtp).not.toHaveBeenCalled();
    expect(controller.getSnapshot()).toMatchObject({ cooldownSeconds: 0, error: null });
    controller.setPhone(PHONE_A);
    expect(controller.getSnapshot().cooldownSeconds).toBe(60);
    controller.dispose();
  });

  it("leaves no invented countdown after a challenge transport failure before any reservation is known", async () => {
    const { controller } = harness({ api: { challenge: vi.fn().mockRejectedValue(new Error("offline")) } });
    await controller.start(PHONE_A).catch(() => {});
    expect(controller.getSnapshot()).toMatchObject({ phase: "idle", cooldownSeconds: 0 });
    controller.dispose();
  });

  it("uses one challenge and verifies with Twilio after automatic fallback", async () => {
    const { controller, api, sendFirebaseOtp } = harness();
    const started = controller.start(PHONE_A);
    await expect(controller.start(PHONE_A)).resolves.toMatchObject({ started: false, reason: "in-flight" });
    await expect(started).resolves.toEqual({ started: true, provider: "twilio" });
    expect(controller.getSnapshot()).toMatchObject({ phase: "code", provider: "twilio" });
    await controller.verify("123456");
    expect(api.challenge).toHaveBeenCalledTimes(1);
    expect(sendFirebaseOtp).toHaveBeenCalledTimes(1);
    expect(api.fallback).toHaveBeenCalledTimes(1);
    expect(api.complete).toHaveBeenCalledWith({ challengeToken: "mock-token-1", provider: "twilio", code: "123456" });
    controller.dispose();
  });
});

describe("send boundaries", () => {
  it("waits for Firebase's final outcome despite Enterprise-to-v2 information", async () => {
    const pending = deferred();
    const { controller, api } = harness({ sendFirebaseOtp: vi.fn(() => pending.promise) });
    const started = controller.start(PHONE_A);
    await vi.advanceTimersByTimeAsync(0);
    expect(api.fallback).not.toHaveBeenCalled();
    pending.resolve({ confirm: vi.fn() });
    await expect(started).resolves.toMatchObject({ provider: "firebase" });
    expect(api.fallback).not.toHaveBeenCalled();
    controller.dispose();
  });

  it.each(["auth/too-many-requests", "auth/invalid-phone-number", "auth/app-not-authorized", "auth/operation-not-allowed", "OTP_RATE_LIMITED"])("does not bypass %s", async (code) => {
    const { controller, api } = harness({ sendFirebaseOtp: vi.fn().mockRejectedValue(failure(code)) });
    await controller.start(PHONE_A).catch(() => {});
    expect(api.fallback).not.toHaveBeenCalled();
    controller.dispose();
  });

  it("does not complete a Firebase credential that became stale while confirming", async () => {
    const pending = deferred();
    let current = true;
    const api = { complete: vi.fn() };
    const completing = completeOtpClientFlow({ flow: { provider: "firebase", confirmationResult: { confirm: () => pending.promise } }, code: "123456", api, isCurrentAttempt: () => current }).catch((error) => error);
    current = false;
    pending.resolve({ user: { getIdToken: vi.fn().mockResolvedValue("private-id-token") } });
    expect(await completing).toMatchObject({ code: "OTP_FLOW_CANCELLED" });
    expect(api.complete).not.toHaveBeenCalled();
  });

  it("publishes the reservation before a Firebase failure to its caller", async () => {
    const onChallenge = vi.fn();
    const problem = new Error("raw exception");
    await startOtpClientFlow({ phone: PHONE_A, purpose: "booking", containerId: "mock", api: { challenge: async () => ({ provider: "firebase", retryAfterSeconds: 60, challengeToken: "secret" }) }, onChallenge, sendFirebaseOtp: async () => { throw problem; } }).catch(() => {});
    expect(onChallenge).toHaveBeenCalledWith(expect.objectContaining({ retryAfterSeconds: 60 }));
  });
});
