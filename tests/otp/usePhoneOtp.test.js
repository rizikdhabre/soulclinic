import { beforeEach, describe, expect, it, vi } from "vitest";
import { createPhoneOtpController } from "@/hooks/usePhoneOtp";

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function createScheduler() {
  const callbacks = [];
  let time = 0;
  return {
    now: () => time,
    schedule: vi.fn((callback) => {
      callbacks.push(callback);
      return callback;
    }),
    cancel: vi.fn((callback) => {
      const index = callbacks.indexOf(callback);
      if (index >= 0) callbacks.splice(index, 1);
    }),
    tick() {
      time += 1000;
      const callback = callbacks.shift();
      callback?.();
    },
  };
}

function createHarness(overrides = {}) {
  const scheduler = createScheduler();
  const dependencies = {
    api: {},
    startFlow: vi.fn().mockResolvedValue({
      challengeToken: "challenge-token",
      provider: "twilio",
      retryAfterSeconds: 2,
    }),
    completeFlow: vi.fn().mockResolvedValue({
      success: true,
      purpose: "booking",
      verificationToken: "booking-grant",
    }),
    schedule: scheduler.schedule,
    cancel: scheduler.cancel,
    now: scheduler.now,
    ...overrides,
  };
  const controller = createPhoneOtpController({
    purpose: "booking",
    ...dependencies,
  });
  return { controller, dependencies, scheduler };
}

describe("createPhoneOtpController", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("guards start, verify, and resend with one shared in-flight operation", async () => {
    const start = deferred();
    const flowRef = { current: null };
    const inFlightRef = { current: false };
    const { controller, dependencies } = createHarness({
      startFlow: vi.fn().mockReturnValue(start.promise),
      flowRef,
      inFlightRef,
    });

    const first = controller.start("+972521234567");
    expect(inFlightRef.current).toBe(true);
    await expect(controller.start("+972521234567")).resolves.toEqual({
      started: false,
      reason: "in-flight",
    });
    await expect(controller.verify("654321")).resolves.toBeUndefined();
    await expect(controller.resend("+972521234567")).resolves.toEqual({
      started: false,
      reason: "not-ready",
    });
    expect(dependencies.startFlow).toHaveBeenCalledTimes(1);

    start.resolve({
      challengeToken: "challenge-token",
      provider: "twilio",
      retryAfterSeconds: 2,
    });
    await expect(first).resolves.toEqual({
      started: true,
      provider: "twilio",
    });
    expect(inFlightRef.current).toBe(false);
    expect(flowRef.current).toEqual(
      expect.objectContaining({
        challengeToken: "challenge-token",
      }),
    );
    expect(controller.getSnapshot()).toMatchObject({
      phase: "code",
      smsSent: true,
      canRetrySend: false,
      provider: "twilio",
      loading: false,
      cooldownSeconds: 2,
    });
  });

  it("counts down the server cooldown and blocks resend until it expires", async () => {
    const { controller, dependencies, scheduler } = createHarness();
    await controller.start("+972521234567");

    await controller.resend("+972521234567");
    expect(dependencies.startFlow).toHaveBeenCalledTimes(1);

    scheduler.tick();
    expect(controller.getSnapshot().cooldownSeconds).toBe(1);
    scheduler.tick();
    expect(controller.getSnapshot().cooldownSeconds).toBe(0);

    await controller.resend("+972521234567");
    expect(dependencies.startFlow).toHaveBeenCalledTimes(2);
  });

  it("recovers from a rejected resend with one fresh start after cooldown", async () => {
    const flowRef = { current: null };
    const resendError = Object.assign(
      new Error("raw resend failure +972521234567"),
      {
        code: "ERR_BAD_REQUEST",
        response: {
          data: {
            error: "OTP_SOURCE_RATE_LIMITED",
            message: "raw provider detail",
            retryAfterSeconds: 2,
          },
        },
      },
    );
    const startFlow = vi
      .fn()
      .mockResolvedValueOnce({
        challengeToken: "initial-challenge",
        provider: "twilio",
        retryAfterSeconds: 1,
      })
      .mockRejectedValueOnce(resendError)
      .mockResolvedValueOnce({
        challengeToken: "fresh-challenge",
        provider: "twilio",
        retryAfterSeconds: 0,
      });
    const { controller, dependencies, scheduler } = createHarness({
      flowRef,
      startFlow,
    });

    await controller.start("+972521234567");
    scheduler.tick();
    await expect(controller.resend()).rejects.toBe(resendError);

    expect(flowRef.current).toBeNull();
    expect(controller.getSnapshot()).toEqual({
      statusMessage: "",
      phase: "idle",
      smsSent: false,
      canRetrySend: false,
      provider: null,
      loading: false,
      error: {
        code: "OTP_SOURCE_RATE_LIMITED",
        message: "Unable to send a verification code.",
        retryAfterSeconds: 2,
      },
      cooldownSeconds: 2,
    });
    const failedSnapshot = JSON.stringify(controller.getSnapshot());
    expect(failedSnapshot).not.toContain("raw resend failure");
    expect(failedSnapshot).not.toContain("raw provider detail");
    expect(failedSnapshot).not.toContain("+972521234567");

    await expect(controller.resend()).resolves.toEqual({
      started: false,
      reason: "not-ready",
    });
    await expect(
      controller.start("+972521234567"),
    ).resolves.toEqual({ started: false, reason: "cooldown" });
    expect(dependencies.startFlow).toHaveBeenCalledTimes(2);

    scheduler.tick();
    scheduler.tick();
    await controller.start("+972521234567");

    expect(dependencies.startFlow).toHaveBeenCalledTimes(3);
    expect(flowRef.current).toEqual(
      expect.objectContaining({ challengeToken: "fresh-challenge" }),
    );
    expect(controller.getSnapshot()).toEqual({
      statusMessage: "",
      phase: "code",
      smsSent: true,
      canRetrySend: false,
      provider: "twilio",
      loading: false,
      error: null,
      cooldownSeconds: 0,
    });
  });

  it("completes the retained flow and drops flow state on completion", async () => {
    const flowRef = { current: null };
    const { controller, dependencies } = createHarness({ flowRef });
    await controller.start("+972521234567");

    const completion = await controller.verify("654321");

    expect(completion).toEqual({
      success: true,
      purpose: "booking",
      verificationToken: "booking-grant",
    });
    expect(dependencies.completeFlow).toHaveBeenCalledWith({
      flow: expect.objectContaining({
        challengeToken: "challenge-token",
        provider: "twilio",
      }),
      code: "654321",
      api: dependencies.api,
      getFirebaseClient: expect.any(Function),
      isCurrentAttempt: expect.any(Function),
    });
    expect(controller.getSnapshot()).toEqual({
      statusMessage: "",
      phase: "complete",
      smsSent: true,
      canRetrySend: false,
      provider: "twilio",
      loading: false,
      error: null,
      cooldownSeconds: 0,
    });
    expect(flowRef.current).toBeNull();
    await expect(controller.verify("654321")).rejects.toMatchObject({
      code: "OTP_FLOW_NOT_STARTED",
    });
    expect(dependencies.completeFlow).toHaveBeenCalledTimes(1);
  });

  it("does not resend after successful completion", async () => {
    const { controller, dependencies } = createHarness();
    await controller.start("+972521234567");
    await controller.verify("654321");

    await expect(
      controller.resend("+972521234567"),
    ).resolves.toEqual({ started: false, reason: "not-ready" });

    expect(dependencies.startFlow).toHaveBeenCalledTimes(1);
    expect(controller.getSnapshot().phase).toBe("complete");
  });

  it("rejects a verification result that resolves after reset", async () => {
    const completion = deferred();
    const { controller } = createHarness({
      completeFlow: vi.fn().mockReturnValue(completion.promise),
    });
    await controller.start("+972521234567");

    const pendingVerify = controller.verify("654321");
    controller.reset();
    completion.resolve({
      success: true,
      purpose: "booking",
      verificationToken: "stale-booking-grant",
    });

    await expect(pendingVerify).rejects.toMatchObject({
      code: "OTP_FLOW_CANCELLED",
      message: "OTP flow was cancelled.",
    });
    expect(controller.getSnapshot()).toEqual({
      statusMessage: "",
      phase: "idle",
      smsSent: false,
      canRetrySend: false,
      provider: null,
      loading: false,
      error: null,
      cooldownSeconds: 2,
    });
  });

  it("rejects a verification result that resolves after disposal", async () => {
    const completion = deferred();
    const { controller } = createHarness({
      completeFlow: vi.fn().mockReturnValue(completion.promise),
    });
    await controller.start("+972521234567");

    const pendingVerify = controller.verify("654321");
    controller.dispose();
    completion.resolve({
      success: true,
      purpose: "booking",
      verificationToken: "stale-booking-grant",
    });

    const cancellation = await pendingVerify.catch((error) => error);
    expect(cancellation).toMatchObject({
      code: "OTP_FLOW_CANCELLED",
      message: "OTP flow was cancelled.",
    });
    expect(`${cancellation.code} ${cancellation.message}`).not.toContain(
      "stale-booking-grant",
    );
  });

  it("ignores stale start results after reset without reviving its token", async () => {
    const start = deferred();
    const { controller, dependencies } = createHarness({
      startFlow: vi.fn().mockReturnValue(start.promise),
    });

    const pendingStart = controller.start("+972521234567");
    controller.reset();
    start.resolve({
      challengeToken: "stale-token",
      provider: "twilio",
      retryAfterSeconds: 60,
    });
    await pendingStart;

    expect(controller.getSnapshot()).toEqual({
      statusMessage: "",
      phase: "idle",
      smsSent: false,
      canRetrySend: false,
      provider: null,
      loading: false,
      error: null,
      cooldownSeconds: 0,
    });
  });


  it.each(["OTP_RECOVERY_INVALID", "OTP_PURPOSE_MISMATCH"])("projects %s without exposing its private response", async (code) => {
    const error = Object.assign(new Error("private completion detail"), {
      response: { data: { error: { code, message: "private response" }, recoveryReceipt: "private-receipt" } },
    });
    const { controller } = createHarness({ completeFlow: vi.fn().mockRejectedValue(error) });
    try {
      await controller.start("+972521234567");
      await expect(controller.verify("123456")).rejects.toBe(error);
      expect(controller.getSnapshot()).toMatchObject({ phase: "code", error: { code } });
      expect(JSON.stringify(controller.getSnapshot())).not.toContain("private");
    } finally {
      controller.dispose();
    }
  });

  it("collapses an unknown nested completion error to the fixed public failure", async () => {
    const completionError = Object.assign(new Error("transport secret"), {
      code: "ERR_BAD_REQUEST",
      response: {
        data: {
          success: false,
          error: {
            code: "PRIVATE_COMPLETION_DETAIL",
            message: "private nested message +972521234567",
          },
        },
      },
    });
    const { controller } = createHarness({
      completeFlow: vi.fn().mockRejectedValue(completionError),
    });
    await controller.start("+972521234567");

    await expect(controller.verify("000000")).rejects.toBe(completionError);

    expect(controller.getSnapshot().error).toEqual({
      code: "OTP_REQUEST_FAILED",
      message: "Unable to verify the code.",
    });
    const serialized = JSON.stringify(controller.getSnapshot());
    expect(serialized).not.toContain("PRIVATE_COMPLETION_DETAIL");
    expect(serialized).not.toContain("private nested message");
    expect(serialized).not.toContain("+972521234567");
  });

  it("caps accepted retry-after values at the controller limit", async () => {
    const routeError = Object.assign(new Error("request failed"), {
      response: {
        data: {
          error: "OTP_SOURCE_RATE_LIMITED",
          retryAfterSeconds: 999_999,
        },
      },
    });
    const { controller } = createHarness({
      startFlow: vi.fn().mockRejectedValue(routeError),
    });

    await expect(controller.start("+972521234567")).rejects.toBe(routeError);

    expect(controller.getSnapshot().error).toEqual({
      code: "OTP_SOURCE_RATE_LIMITED",
      message: "Unable to send a verification code.",
      retryAfterSeconds: 3600,
    });
    expect(controller.getSnapshot().cooldownSeconds).toBe(3600);
  });

  it("replaces an unsafe error code instead of exposing it in public state", async () => {
    const unsafeError = Object.assign(new Error("request failed"), {
      code: "secret-token +972521234567",
    });
    const { controller } = createHarness({
      startFlow: vi.fn().mockRejectedValue(unsafeError),
    });

    await expect(controller.start("+972521234567")).rejects.toBe(unsafeError);
    expect(controller.getSnapshot().error).toEqual({
      code: "OTP_REQUEST_FAILED",
      message: "Unable to send a verification code.",
    });
    expect(JSON.stringify(controller.getSnapshot())).not.toContain("+972521234567");
    expect(JSON.stringify(controller.getSnapshot())).not.toContain("secret-token");
  });

  it.each([
    "654321",
    "eyJhbGciOiJIUzI1NiJ9",
    "c2hvcnQtdG9rZW4",
    "OTP_NOT_A_REAL_ERROR",
    "PRIVATE_NOT_A_KNOWN_CODE",
  ])("maps unknown or opaque error code %s to the fixed public failure", async (value) => {
    const unsafeError = Object.assign(new Error("request failed"), {
      code: value,
      response: { data: { error: value } },
    });
    const { controller } = createHarness({
      startFlow: vi.fn().mockRejectedValue(unsafeError),
    });

    await expect(controller.start("+972521234567")).rejects.toBe(unsafeError);

    expect(controller.getSnapshot().error).toEqual({
      code: "OTP_REQUEST_FAILED",
      message: "Unable to send a verification code.",
    });
    const serialized = JSON.stringify(controller.getSnapshot());
    expect(serialized).not.toContain(value);
  });

  it("cleans up timers and flow ownership when disposed", async () => {
    const { controller, dependencies, scheduler } = createHarness();
    await controller.start("+972521234567");

    controller.dispose();

    expect(scheduler.cancel).toHaveBeenCalledTimes(1);
  });

});
