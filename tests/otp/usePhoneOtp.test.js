import { beforeEach, describe, expect, it, vi } from "vitest";
import { createPhoneOtpController } from "@/hooks/usePhoneOtp";

vi.mock("@/lib/phoneAuth", () => ({
  clearFirebaseRecaptcha: vi.fn(),
  sendFirebaseOtp: vi.fn(),
}));

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
    sendFirebaseOtp: vi.fn(),
    clearFirebaseRecaptcha: vi.fn(),
    startFlow: vi.fn().mockResolvedValue({
      challengeToken: "challenge-token",
      provider: "firebase",
      retryAfterSeconds: 2,
      confirmationResult: { confirm: vi.fn() },
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
    recaptchaContainerId: "appointment-recaptcha",
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
      provider: "firebase",
      retryAfterSeconds: 2,
      confirmationResult: { confirm: vi.fn() },
    });
    await expect(first).resolves.toEqual({
      started: true,
      provider: "firebase",
    });
    expect(inFlightRef.current).toBe(false);
    expect(flowRef.current).toEqual(
      expect.objectContaining({
        challengeToken: "challenge-token",
        confirmationResult: expect.any(Object),
      }),
    );
    expect(controller.getSnapshot()).toMatchObject({
      phase: "code",
      provider: "firebase",
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
    expect(dependencies.clearFirebaseRecaptcha).toHaveBeenCalledWith(
      "appointment-recaptcha",
    );
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
        provider: "firebase",
        retryAfterSeconds: 1,
        confirmationResult: { confirm: vi.fn() },
      })
      .mockRejectedValueOnce(resendError)
      .mockResolvedValueOnce({
        challengeToken: "fresh-challenge",
        provider: "firebase",
        retryAfterSeconds: 0,
        confirmationResult: { confirm: vi.fn() },
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
      phase: "idle",
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
      phase: "code",
      provider: "firebase",
      loading: false,
      error: null,
      cooldownSeconds: 0,
    });
  });

  it("dispatches code entry by the retained provider and drops flow state on completion", async () => {
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
        provider: "firebase",
      }),
      code: "654321",
      api: dependencies.api,
      isCurrentAttempt: expect.any(Function),
    });
    expect(controller.getSnapshot()).toEqual({
      phase: "complete",
      provider: "firebase",
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
    const clearCountAfterCompletion =
      dependencies.clearFirebaseRecaptcha.mock.calls.length;

    await expect(
      controller.resend("+972521234567"),
    ).resolves.toEqual({ started: false, reason: "not-ready" });

    expect(dependencies.startFlow).toHaveBeenCalledTimes(1);
    expect(dependencies.clearFirebaseRecaptcha).toHaveBeenCalledTimes(
      clearCountAfterCompletion,
    );
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
      phase: "idle",
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

  it("ignores stale start results after reset and clears the settled verifier", async () => {
    const start = deferred();
    const { controller, dependencies } = createHarness({
      startFlow: vi.fn().mockReturnValue(start.promise),
    });

    const pendingStart = controller.start("+972521234567");
    controller.reset();
    start.resolve({
      challengeToken: "stale-token",
      provider: "firebase",
      retryAfterSeconds: 60,
      confirmationResult: { confirm: vi.fn() },
    });
    await pendingStart;

    expect(controller.getSnapshot()).toEqual({
      phase: "idle",
      provider: null,
      loading: false,
      error: null,
      cooldownSeconds: 0,
    });
    expect(dependencies.clearFirebaseRecaptcha).toHaveBeenCalledTimes(2);
  });

  it("keeps raw failures and sensitive flow values out of public state", async () => {
    const rawError = Object.assign(new Error("failed for +972521234567 with secret-token"), {
      code: "auth/internal-error",
      customData: { phoneNumber: "+972521234567" },
      response: { data: { challengeToken: "secret-token", message: "raw backend message" } },
    });
    const { controller } = createHarness({
      startFlow: vi.fn().mockRejectedValue(rawError),
    });

    await expect(controller.start("+972521234567")).rejects.toBe(rawError);

    expect(controller.getSnapshot()).toEqual({
      phase: "idle",
      provider: null,
      loading: false,
      error: {
        code: "auth/internal-error",
        message: "Unable to send a verification code.",
      },
      cooldownSeconds: 0,
    });
    const serialized = JSON.stringify(controller.getSnapshot());
    expect(serialized).not.toContain("+972521234567");
    expect(serialized).not.toContain("secret-token");
    expect(serialized).not.toContain("raw backend message");
  });

  it("prefers the server OTP code over an Axios transport code", async () => {
    const axiosError = Object.assign(new Error("request failed"), {
      code: "ERR_BAD_REQUEST",
      response: {
        data: {
          error: "OTP_RATE_LIMITED",
          message: "raw backend message",
          retryAfterSeconds: 17,
        },
      },
    });
    const { controller } = createHarness({
      startFlow: vi.fn().mockRejectedValue(axiosError),
    });

    await expect(controller.start("+972521234567")).rejects.toBe(axiosError);
    expect(controller.getSnapshot().error).toEqual({
      code: "OTP_RATE_LIMITED",
      message: "Unable to send a verification code.",
      retryAfterSeconds: 17,
    });
    expect(controller.getSnapshot().cooldownSeconds).toBe(17);
  });

  it("accepts the flat route error shape with a bounded retry interval", async () => {
    const routeError = Object.assign(new Error("request failed"), {
      code: "ERR_BAD_REQUEST",
      response: {
        data: {
          error: "OTP_SOURCE_RATE_LIMITED",
          retryAfterSeconds: 45,
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
      retryAfterSeconds: 45,
    });
    expect(controller.getSnapshot().cooldownSeconds).toBe(45);
  });

  it("accepts the nested completion error code without exposing its message", async () => {
    const completionError = Object.assign(new Error("request failed"), {
      code: "ERR_BAD_REQUEST",
      response: {
        data: {
          success: false,
          error: {
            code: "INVALID_OTP",
            message: "raw completion message with private detail",
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
      code: "INVALID_OTP",
      message: "Unable to verify the code.",
    });
    expect(JSON.stringify(controller.getSnapshot())).not.toContain(
      "raw completion message",
    );
  });

  it("keeps Firebase invalid-verification-code allowlisted for code entry", async () => {
    const firebaseError = Object.assign(new Error("wrong Firebase code"), {
      code: "auth/invalid-verification-code",
    });
    const { controller } = createHarness({
      completeFlow: vi.fn().mockRejectedValue(firebaseError),
    });
    await controller.start("+972521234567");

    await expect(controller.verify("000000")).rejects.toBe(firebaseError);

    expect(controller.getSnapshot().error).toEqual({
      code: "auth/invalid-verification-code",
      message: "Unable to verify the code.",
    });
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
    "auth/not-a-known-code",
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

  it("cleans up timers and verifier ownership when disposed", async () => {
    const { controller, dependencies, scheduler } = createHarness();
    await controller.start("+972521234567");

    controller.dispose();

    expect(scheduler.cancel).toHaveBeenCalledTimes(1);
    expect(dependencies.clearFirebaseRecaptcha).toHaveBeenCalledWith(
      "appointment-recaptcha",
    );
  });

  it("clears Firebase ownership when start transitions to Twilio", async () => {
    const { controller, dependencies } = createHarness({
      startFlow: vi.fn().mockResolvedValue({
        challengeToken: "challenge-token",
        provider: "twilio",
        retryAfterSeconds: 60,
      }),
    });

    await controller.start("+972521234567");

    expect(controller.getSnapshot().provider).toBe("twilio");
    expect(dependencies.clearFirebaseRecaptcha).toHaveBeenCalledTimes(1);
  });
});
