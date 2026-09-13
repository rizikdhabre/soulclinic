import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createPhoneOtpController } from "@/hooks/usePhoneOtp";
const PHONE_A = "+972521234567";
const PHONE_B = "+972521234568";
const failure = (code) => Object.assign(new Error("mock provider failure"), { code });
function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function harness(options = {}) {
  let token = 0;
  const api = {
    challenge: vi.fn(async () => ({
      provider: "twilio", challengeToken: `mock-token-${++token}`,
      expiresAt: new Date(Date.now() + 600_000).toISOString(),
      serverTime: new Date().toISOString(), retryAt: new Date(Date.now() + 60_000).toISOString(), retryAfterSeconds: 60,
    })),
    send: vi.fn().mockResolvedValue({ provider: "twilio", status: "pending" }),
    complete: vi.fn().mockResolvedValue({ success: true, purpose: "booking" }),
    ...options.api,
  };
  const flowRef = { current: null };
  const controller = createPhoneOtpController({ purpose: "booking", api, flowRef });
  return { controller, api, flowRef };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-09-07T12:00:00.000Z"));
  vi.spyOn(console, "info").mockImplementation(() => {});
});
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe("OTP attempt cooldown and phone ownership", () => {
  it("retains a failed send's reservation while allowing a manual same-challenge retry nine seconds later", async () => {
    const { controller, api } = harness({
      api: { send: vi.fn().mockRejectedValueOnce(failure("OTP_SEND_FAILED")).mockResolvedValue({ provider: "twilio", status: "pending" }) },
    });
    await expect(controller.start(PHONE_A)).rejects.toMatchObject({ code: "OTP_SEND_FAILED" });
    expect(controller.getSnapshot()).toMatchObject({ phase: "send-recovery", smsSent: false, cooldownSeconds: 60, error: { code: "OTP_SEND_FAILED" } });
    await vi.advanceTimersByTimeAsync(9000);
    expect(controller.getSnapshot().cooldownSeconds).toBe(51);
    expect(controller.getSnapshot().canRetrySend).toBe(true);
    await expect(controller.start(PHONE_A)).resolves.toEqual({ started: true, provider: "twilio" });
    expect(api.challenge).toHaveBeenCalledTimes(1);
    expect(api.send).toHaveBeenCalledTimes(2);
    expect(api.send).toHaveBeenLastCalledWith({ challengeToken: "mock-token-1" });
    await expect(controller.resend()).resolves.toEqual({ started: false, reason: "cooldown" });
    controller.dispose();
  });

  it("reserves during sending and does not restart the deadline after a slow failure", async () => {
    const pending = deferred();
    const { controller } = harness({ api: { send: vi.fn(() => pending.promise) } });
    const started = controller.start(PHONE_A).catch((error) => error);
    await vi.advanceTimersByTimeAsync(0);
    expect(controller.getSnapshot().cooldownSeconds).toBe(60);
    await vi.advanceTimersByTimeAsync(9000);
    pending.reject(new Error("uncoded runtime failure"));
    await started;
    expect(controller.getSnapshot()).toMatchObject({ cooldownSeconds: 51, phase: "send-recovery" });
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
        provider: "twilio", challengeToken: "mock-token",
        serverTime: "2026-09-07T12:00:00.000Z", retryAt: "2026-09-07T12:01:00.000Z",
        retryAfterSeconds: 60,
      }), send: vi.fn().mockRejectedValue(failure("OTP_SEND_FAILED")) },
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
    const { controller } = harness({ api: { send: vi.fn().mockRejectedValue(failure("OTP_SEND_FAILED")) } });
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

  it.each(["OTP_SOURCE_RATE_LIMITED", "OTP_SEND_SOURCE_RATE_LIMITED"])("keeps %s across phone changes", async (code) => {
    const rejected = Object.assign(new Error("limited"), { response: { data: { error: code, retryAfterSeconds: 90, restrictionScope: "source" } } });
    const api = code === "OTP_SOURCE_RATE_LIMITED" ? { challenge: vi.fn().mockRejectedValue(rejected) } : { send: vi.fn().mockRejectedValue(rejected) };
    const { controller, api: requests } = harness({ api });
    await controller.start(PHONE_A).catch(() => {});
    controller.setPhone(PHONE_B);
    expect(controller.getSnapshot()).toMatchObject({ cooldownSeconds: 90, error: { code } });
    await expect(controller.start(PHONE_B)).resolves.toEqual({ started: false, reason: "cooldown" });
    expect(requests.challenge).toHaveBeenCalledTimes(1);
    controller.dispose();
  });

  it("ignores a stale send failure after a phone edit", async () => {
    const pending = deferred();
    const { controller, api } = harness({ api: { send: vi.fn(() => pending.promise) } });
    const started = controller.start(PHONE_A);
    await vi.advanceTimersByTimeAsync(0);
    controller.setPhone(PHONE_B);
    pending.reject(failure("OTP_SEND_PENDING"));
    await expect(started).resolves.toMatchObject({ started: false, reason: "cancelled" });
    expect(api.send).toHaveBeenCalledTimes(1);
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
    const { controller, api } = harness({ api: { challenge: vi.fn(() => pending.promise) } });
    const started = controller.start(PHONE_A);
    controller.setPhone(PHONE_B);
    pending.resolve({ provider: "twilio", challengeToken: "old-token", retryAfterSeconds: 60 });
    await expect(started).resolves.toMatchObject({ started: false, reason: "cancelled" });
    expect(api.send).not.toHaveBeenCalled();
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

  it("uses one challenge and one send before verifying with Twilio", async () => {
    const { controller, api } = harness();
    const started = controller.start(PHONE_A);
    await expect(controller.start(PHONE_A)).resolves.toMatchObject({ started: false, reason: "in-flight" });
    await expect(started).resolves.toEqual({ started: true, provider: "twilio" });
    expect(controller.getSnapshot()).toMatchObject({ phase: "code", provider: "twilio" });
    await controller.verify("123456");
    expect(api.challenge).toHaveBeenCalledTimes(1);
    expect(api.send).toHaveBeenCalledTimes(1);
    expect(api.complete).toHaveBeenCalledWith({ challengeToken: "mock-token-1", purpose: "booking", code: "123456" });
    controller.dispose();
  });
});

describe("prepared sends and completion retries", () => {
  it("recovers the fifth phone challenge before its receipt expires despite the 3360-second new-send cooldown", async () => {
    const { controller, api, flowRef } = harness();
    try {
      for (let count = 0; count < 4; count += 1) {
        await controller.start(PHONE_A);
        await vi.advanceTimersByTimeAsync(60_000);
      }
      api.challenge.mockResolvedValueOnce({
        provider: "twilio", challengeToken: "mock-token-5",
        expiresAt: new Date(Date.now() + 600_000).toISOString(),
        retryAfterSeconds: 3360, serverTime: new Date().toISOString(),
        retryAt: new Date(Date.now() + 3_360_000).toISOString(),
      });
      const persistenceError = Object.assign(new Error("private persistence detail"), {
        response: { data: { error: "OTP_PERSISTENCE_FAILED", recoveryReceipt: "private-ten-minute-receipt" } },
      });
      api.send.mockRejectedValueOnce(persistenceError);
      await expect(controller.start(PHONE_A)).rejects.toBe(persistenceError);
      const prepared = flowRef.current;
      expect(controller.getSnapshot()).toMatchObject({ phase: "send-recovery", smsSent: false, canRetrySend: true, cooldownSeconds: 3360 });
      expect(JSON.stringify(controller.getSnapshot())).not.toContain("private-");
      await vi.advanceTimersByTimeAsync(9000);
      expect(api.send).toHaveBeenCalledTimes(5);
      await expect(controller.resend()).resolves.toEqual({ started: true, provider: "twilio" });
      expect(flowRef.current).toBe(prepared);
      expect(api.challenge).toHaveBeenCalledTimes(5);
      expect(api.send).toHaveBeenCalledTimes(6);
      expect(api.send).toHaveBeenLastCalledWith({ challengeToken: "mock-token-5", recoveryReceipt: "private-ten-minute-receipt" });
      expect(controller.getSnapshot()).toMatchObject({ smsSent: true, canRetrySend: false, cooldownSeconds: 3351 });
      await expect(controller.resend()).resolves.toMatchObject({ reason: "cooldown" });
      await expect(controller.start(PHONE_A)).resolves.toMatchObject({ reason: "cooldown" });
      expect(api.challenge).toHaveBeenCalledTimes(5);
      expect(api.send).toHaveBeenCalledTimes(6);
    } finally {
      controller.dispose();
    }
  });

  it.each(["OTP_SEND_FAILED", "OTP_CHALLENGE_EXPIRED"])("escapes a terminal %s send only on an explicit resend after cooldown", async (code) => {
    const error = Object.assign(new Error("terminal send"), { response: { data: { error: code, restartAllowed: true } } });
    const { controller, api, flowRef } = harness({ api: { send: vi.fn().mockRejectedValueOnce(error).mockResolvedValue({ provider: "twilio", status: "pending" }) } });
    try {
      await expect(controller.start(PHONE_A)).rejects.toBe(error);
      expect(flowRef.current.sendStatus).toBe("failed");
      expect(controller.getSnapshot()).toMatchObject({ phase: "idle", smsSent: false, canRetrySend: false, error: { code }, cooldownSeconds: 60 });
      await expect(controller.resend()).resolves.toMatchObject({ reason: "cooldown" });
      await vi.advanceTimersByTimeAsync(60_000);
      expect(api.send).toHaveBeenCalledTimes(1);
      expect(api.challenge).toHaveBeenCalledTimes(1);
      await controller.resend();
      expect(api.challenge).toHaveBeenCalledTimes(2);
      expect(api.send).toHaveBeenLastCalledWith({ challengeToken: "mock-token-2" });
      expect(controller.getSnapshot()).toMatchObject({ phase: "code", smsSent: true, error: null });
    } finally {
      controller.dispose();
    }
  });

  it("replays an unknown send manually first, then permits a fresh challenge after the server declares expiry", async () => {
    const expired = Object.assign(new Error("expired unknown send"), { response: { data: { error: "OTP_CHALLENGE_EXPIRED", restartAllowed: true, retryAfterSeconds: 30 } } });
    const { controller, api, flowRef } = harness({ api: { send: vi.fn().mockRejectedValueOnce(new Error("connection lost")).mockRejectedValueOnce(expired).mockResolvedValue({ provider: "twilio", status: "pending" }) } });
    try {
      await controller.start(PHONE_A).catch(() => {});
      expect(flowRef.current.sendStatus).toBe("prepared");
      await vi.advanceTimersByTimeAsync(600_000);
      expect(api.send).toHaveBeenCalledTimes(1);
      await expect(controller.resend()).rejects.toBe(expired);
      expect(api.challenge).toHaveBeenCalledTimes(1);
      expect(api.send).toHaveBeenNthCalledWith(2, { challengeToken: "mock-token-1" });
      expect(flowRef.current.sendStatus).toBe("failed");
      await expect(controller.start(PHONE_A)).resolves.toMatchObject({ reason: "cooldown" });
      await vi.advanceTimersByTimeAsync(30_000);
      expect(api.send).toHaveBeenCalledTimes(2);
      await controller.start(PHONE_A);
      expect(api.challenge).toHaveBeenCalledTimes(2);
      expect(api.send).toHaveBeenNthCalledWith(3, { challengeToken: "mock-token-2" });
    } finally {
      controller.dispose();
    }
  });

  it("honors fresh send cooldown metadata without restarting a slow challenge reservation", async () => {
    const pending = deferred();
    const { controller } = harness({ api: { send: vi.fn(() => pending.promise) } });
    const started = controller.start(PHONE_A);
    await vi.advanceTimersByTimeAsync(9000);
    pending.resolve({ provider: "twilio", status: "pending", serverTime: "2026-09-07T12:00:09.000Z", retryAt: "2026-09-07T12:02:00.000Z", retryAfterSeconds: 111 });
    await started;
    expect(controller.getSnapshot().cooldownSeconds).toBe(111);
    await vi.advanceTimersByTimeAsync(9000);
    expect(controller.getSnapshot().cooldownSeconds).toBe(102);
    controller.dispose();
  });

  it.each(["OTP_SEND_PENDING", "OTP_SEND_TEMPORARY_FAILURE", "OTP_PERSISTENCE_FAILED"])("retries %s manually using the same challenge and send receipt", async (code) => {
    const error = Object.assign(new Error("private send details"), { response: { data: { error: code, recoveryReceipt: "private-send-receipt" } } });
    const { controller, api, flowRef } = harness({ api: { send: vi.fn().mockRejectedValueOnce(error).mockResolvedValue({ provider: "twilio", status: "pending" }) } });
    await expect(controller.start(PHONE_A)).rejects.toBe(error);
    const flow = flowRef.current;
    expect(flow).toMatchObject({ challengeToken: "mock-token-1", recoveryReceipt: "private-send-receipt" });
    expect(controller.getSnapshot()).toMatchObject({ phase: "send-recovery", smsSent: false, error: { code } });
    expect(JSON.stringify(controller.getSnapshot())).not.toContain("private-");
    await vi.advanceTimersByTimeAsync(60_000);
    expect(api.send).toHaveBeenCalledTimes(1);
    await controller.resend();
    expect(api.challenge).toHaveBeenCalledTimes(1);
    expect(api.send).toHaveBeenLastCalledWith({ challengeToken: "mock-token-1", recoveryReceipt: "private-send-receipt" });
    expect(flowRef.current).toBe(flow);
    expect(controller.getSnapshot()).toMatchObject({ phase: "code", smsSent: true, error: null });
    controller.dispose();
  });

  it("protects a manual same-challenge retry with the shared in-flight lock", async () => {
    const pending = deferred();
    const { controller, api } = harness({ api: { send: vi.fn().mockRejectedValueOnce(failure("OTP_SEND_PENDING")).mockImplementationOnce(() => pending.promise) } });
    await controller.start(PHONE_A).catch(() => {});
    expect(controller.getSnapshot()).toMatchObject({ canRetrySend: true, cooldownSeconds: 60 });
    const retry = controller.resend();
    await expect(controller.start(PHONE_A)).resolves.toMatchObject({ reason: "in-flight" });
    await expect(controller.resend()).resolves.toMatchObject({ reason: "in-flight" });
    await expect(controller.verify("123456")).resolves.toBeUndefined();
    pending.resolve({ provider: "twilio", status: "pending" });
    await retry;
    expect(api.challenge).toHaveBeenCalledTimes(1);
    expect(api.send).toHaveBeenCalledTimes(2);
    controller.dispose();
  });

  it("creates a new challenge only for an explicit resend after successful send and cooldown", async () => {
    const { controller, api } = harness();
    await controller.start(PHONE_A);
    await expect(controller.resend()).resolves.toMatchObject({ reason: "cooldown" });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(api.challenge).toHaveBeenCalledTimes(1);
    await controller.resend();
    expect(api.challenge).toHaveBeenCalledTimes(2);
    expect(api.send).toHaveBeenLastCalledWith({ challengeToken: "mock-token-2" });
    controller.dispose();
  });

  it("never loops or creates a new challenge for an unknown send outcome", async () => {
    const { controller, api } = harness({ api: { send: vi.fn().mockRejectedValue(new Error("connection lost")) } });
    await controller.start(PHONE_A).catch(() => {});
    await vi.advanceTimersByTimeAsync(600_000);
    expect(api.send).toHaveBeenCalledTimes(1);
    await controller.start(PHONE_A).catch(() => {});
    expect(api.challenge).toHaveBeenCalledTimes(1);
    expect(api.send).toHaveBeenLastCalledWith({ challengeToken: "mock-token-1" });
    expect(controller.getSnapshot()).toMatchObject({ smsSent: false, phase: "send-recovery" });
    controller.dispose();
  });

  it.each(["INVALID_OTP", "OTP_VERIFICATION_EXPIRED", "OTP_VERIFY_TEMPORARY_FAILURE", "OTP_PERSISTENCE_FAILED", "OTP_COMPLETION_IN_PROGRESS"])("preserves flow on %s completion failure and retries the receipt", async (code) => {
    const error = Object.assign(new Error("private approval details"), { response: { data: { error: { code }, recoveryReceipt: "private-complete-receipt" } } });
    const { controller, api, flowRef } = harness({ api: { complete: vi.fn().mockRejectedValueOnce(error).mockResolvedValue({ success: true, purpose: "booking", verificationToken: "private-grant" }) } });
    await controller.start(PHONE_A);
    const flow = flowRef.current;
    await expect(controller.verify("123456")).rejects.toBe(error);
    expect(flowRef.current).toBe(flow);
    expect(controller.getSnapshot()).toMatchObject({ phase: "code", error: { code } });
    expect(JSON.stringify(controller.getSnapshot())).not.toContain("private-");
    await expect(controller.verify("123456")).resolves.toMatchObject({ verificationToken: "private-grant" });
    expect(api.complete).toHaveBeenLastCalledWith({ challengeToken: "mock-token-1", purpose: "booking", code: "123456", recoveryReceipt: "private-complete-receipt" });
    expect(api.send).toHaveBeenCalledTimes(1);
    expect(flowRef.current).toBeNull();
    controller.dispose();
  });

  it("retains the full global budget restriction across phone changes and reset", async () => {
    const error = Object.assign(new Error("budget"), { response: { data: { error: "OTP_SEND_BUDGET_EXCEEDED", restrictionScope: "global", retryAfterSeconds: 86400, serverTime: "2026-09-07T12:00:00.000Z", retryAt: "2026-09-08T12:00:00.000Z" } } });
    const { controller, api } = harness({ api: { send: vi.fn().mockRejectedValue(error) } });
    await controller.start(PHONE_A).catch(() => {});
    controller.setPhone(PHONE_B);
    controller.reset();
    expect(controller.getSnapshot()).toMatchObject({ cooldownSeconds: 86400, error: { code: "OTP_SEND_BUDGET_EXCEEDED", retryAfterSeconds: 86400 } });
    await expect(controller.start(PHONE_B)).resolves.toMatchObject({ reason: "cooldown" });
    await vi.advanceTimersByTimeAsync(9000);
    expect(controller.getSnapshot().cooldownSeconds).toBe(86391);
    expect(api.challenge).toHaveBeenCalledTimes(1);
    controller.dispose();
  });

  it("ignores stale send success after disposal", async () => {
    const pending = deferred();
    const { controller, flowRef } = harness({ api: { send: vi.fn(() => pending.promise) } });
    const started = controller.start(PHONE_A);
    await vi.advanceTimersByTimeAsync(0);
    controller.dispose();
    pending.resolve({ provider: "twilio", status: "pending" });
    await expect(started).resolves.toMatchObject({ reason: "cancelled" });
    expect(flowRef.current).toBeNull();
    expect(vi.getTimerCount()).toBe(0);
  });
});
