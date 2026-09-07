import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const firebaseMocks = vi.hoisted(() => ({
  auth: { name: "test-auth" },
  instances: [],
  RecaptchaVerifier: vi.fn(function MockRecaptchaVerifier(auth, containerId, options) {
    const instance = {
      auth,
      containerId,
      options,
      clear: vi.fn(),
      _reset: vi.fn(),
    };
    firebaseMocks.instances.push(instance);
    return instance;
  }),
  signInWithPhoneNumber: vi.fn(),
}));

vi.mock("firebase/auth", () => ({
  RecaptchaVerifier: firebaseMocks.RecaptchaVerifier,
  signInWithPhoneNumber: firebaseMocks.signInWithPhoneNumber,
}));

vi.mock("@/lib/firebase", () => ({ auth: firebaseMocks.auth }));

function installBrowser(containers) {
  global.window = { location: { hostname: "example.test" } };
  global.document = {
    getElementById: vi.fn((containerId) => containers.get(containerId) || null),
  };
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

async function createFlowHarness() {
  const { startOtpClientFlow } = await import("@/lib/otp/client");
  const { sendFirebaseOtp, clearFirebaseRecaptcha } = await import("@/lib/phoneAuth");
  const api = {
    challenge: vi.fn().mockResolvedValue({
      challengeToken: "test-challenge",
      provider: "firebase",
      expiresAt: "2026-09-07T00:10:00.000Z",
      retryAfterSeconds: 60,
    }),
    fallback: vi.fn().mockResolvedValue({ provider: "twilio", status: "pending" }),
  };
  return {
    api,
    start: () => startOtpClientFlow({
      phone: "+972521234567",
      purpose: "booking",
      containerId: "appointment-recaptcha",
      api,
      sendFirebaseOtp,
      clearFirebaseRecaptcha,
    }),
  };
}

describe("Firebase reCAPTCHA registry", () => {
  beforeEach(() => {
    vi.resetModules();
    firebaseMocks.instances.length = 0;
    firebaseMocks.RecaptchaVerifier.mockClear();
    firebaseMocks.signInWithPhoneNumber.mockReset();
    installBrowser(
      new Map([
        ["appointment-recaptcha", {}],
        ["login-recaptcha", {}],
      ]),
    );
  });

  afterEach(() => {
    vi.restoreAllMocks();
    delete global.window;
    delete global.document;
  });

  it("creates one invisible verifier per caller-provided container ID", async () => {
    const { sendFirebaseOtp } = await import("@/lib/phoneAuth");
    firebaseMocks.signInWithPhoneNumber.mockResolvedValue({ confirm: vi.fn() });

    await sendFirebaseOtp("+972521234567", "appointment-recaptcha");
    await sendFirebaseOtp("+972521234567", "appointment-recaptcha");
    await sendFirebaseOtp("+972521234567", "login-recaptcha");

    expect(firebaseMocks.RecaptchaVerifier).toHaveBeenCalledTimes(2);
    expect(firebaseMocks.RecaptchaVerifier).toHaveBeenCalledWith(
      firebaseMocks.auth,
      "appointment-recaptcha",
      expect.objectContaining({ size: "invisible" }),
    );
    expect(firebaseMocks.RecaptchaVerifier).toHaveBeenCalledWith(
      firebaseMocks.auth,
      "login-recaptcha",
      expect.objectContaining({ size: "invisible" }),
    );
    expect(firebaseMocks.instances[0]).not.toBe(firebaseMocks.instances[1]);
    expect(firebaseMocks.signInWithPhoneNumber.mock.calls[0][2]).toBe(
      firebaseMocks.instances[0],
    );
    expect(firebaseMocks.signInWithPhoneNumber.mock.calls[2][2]).toBe(
      firebaseMocks.instances[1],
    );
  });

  it("calls clear at most once for each verifier instance", async () => {
    const { clearFirebaseRecaptcha, sendFirebaseOtp } = await import("@/lib/phoneAuth");
    firebaseMocks.signInWithPhoneNumber.mockResolvedValue({ confirm: vi.fn() });

    await sendFirebaseOtp("+972521234567", "appointment-recaptcha");
    const verifier = firebaseMocks.instances[0];
    clearFirebaseRecaptcha("appointment-recaptcha");
    clearFirebaseRecaptcha("appointment-recaptcha");

    expect(verifier.clear).toHaveBeenCalledTimes(1);
  });

  it("bounds clear failures without retrying or logging their raw code", async () => {
    const { clearFirebaseRecaptcha, sendFirebaseOtp } = await import("@/lib/phoneAuth");
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    firebaseMocks.signInWithPhoneNumber.mockResolvedValue({ confirm: vi.fn() });

    await sendFirebaseOtp("+972521234567", "appointment-recaptcha");
    const verifier = firebaseMocks.instances[0];
    verifier.clear.mockImplementation(() => {
      throw Object.assign(new Error("clear failed"), {
        code: "secret-token +972521234567",
      });
    });

    expect(() => clearFirebaseRecaptcha("appointment-recaptcha")).not.toThrow();
    expect(() => clearFirebaseRecaptcha("appointment-recaptcha")).not.toThrow();
    expect(verifier.clear).toHaveBeenCalledTimes(1);
    const logged = JSON.stringify(warnSpy.mock.calls);
    expect(logged).toContain("auth/unknown");
    expect(logged).not.toContain("+972521234567");
    expect(logged).not.toContain("secret-token");
  });

  it("rethrows the exact send failure after clearing its verifier", async () => {
    const { sendFirebaseOtp } = await import("@/lib/phoneAuth");
    const firebaseError = Object.assign(new Error("send failed for +972521234567"), {
      code: "auth/internal-error",
      customData: { token: "must-not-be-logged" },
    });
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    firebaseMocks.signInWithPhoneNumber.mockRejectedValue(firebaseError);

    await expect(
      sendFirebaseOtp("+972521234567", "appointment-recaptcha"),
    ).rejects.toBe(firebaseError);

    expect(firebaseMocks.instances[0].clear).toHaveBeenCalledTimes(1);
    const logged = JSON.stringify(errorSpy.mock.calls);
    expect(logged).toContain("auth/internal-error");
    expect(logged).toContain("example.test");
    expect(logged).not.toContain("+972521234567");
    expect(logged).not.toContain("must-not-be-logged");
  });

  it("does not log an unbounded Firebase error code", async () => {
    const { sendFirebaseOtp } = await import("@/lib/phoneAuth");
    const firebaseError = Object.assign(new Error("send failed"), {
      code: "secret-token +972521234567",
    });
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    firebaseMocks.signInWithPhoneNumber.mockRejectedValue(firebaseError);

    await expect(
      sendFirebaseOtp("+972521234567", "appointment-recaptcha"),
    ).rejects.toBe(firebaseError);

    const logged = JSON.stringify(errorSpy.mock.calls);
    expect(logged).toContain("auth/unknown");
    expect(logged).not.toContain("+972521234567");
    expect(logged).not.toContain("secret-token");
  });

  it("defers requested cleanup until signInWithPhoneNumber settles", async () => {
    const { clearFirebaseRecaptcha, sendFirebaseOtp } = await import("@/lib/phoneAuth");
    const send = deferred();
    firebaseMocks.signInWithPhoneNumber
      .mockReturnValueOnce(send.promise)
      .mockResolvedValueOnce({ confirm: vi.fn() });

    const pendingSend = sendFirebaseOtp("+972521234567", "appointment-recaptcha");
    await Promise.resolve();
    const verifier = firebaseMocks.instances[0];

    clearFirebaseRecaptcha("appointment-recaptcha");
    expect(verifier.clear).not.toHaveBeenCalled();

    send.resolve({ confirm: vi.fn() });
    await pendingSend;
    expect(verifier.clear).toHaveBeenCalledTimes(1);
  });

  it("rejects a concurrent send for the same container without releasing the active send", async () => {
    const { clearFirebaseRecaptcha, sendFirebaseOtp } = await import("@/lib/phoneAuth");
    const send = deferred();
    firebaseMocks.signInWithPhoneNumber
      .mockReturnValueOnce(send.promise)
      .mockResolvedValueOnce({ confirm: vi.fn() });

    const pendingSend = sendFirebaseOtp("+972521234567", "appointment-recaptcha");
    await Promise.resolve();

    await expect(
      sendFirebaseOtp("+972521234567", "appointment-recaptcha"),
    ).rejects.toMatchObject({ code: "OTP_REQUEST_IN_PROGRESS" });
    clearFirebaseRecaptcha("appointment-recaptcha");
    expect(firebaseMocks.instances[0].clear).not.toHaveBeenCalled();

    send.resolve({ confirm: vi.fn() });
    await pendingSend;
    expect(firebaseMocks.instances[0].clear).toHaveBeenCalledTimes(1);
    expect(firebaseMocks.signInWithPhoneNumber).toHaveBeenCalledTimes(1);
  });

  it("does not let an expired callback from an old verifier clear its replacement", async () => {
    const { clearFirebaseRecaptcha, sendFirebaseOtp } = await import("@/lib/phoneAuth");
    firebaseMocks.signInWithPhoneNumber.mockResolvedValue({ confirm: vi.fn() });

    await sendFirebaseOtp("+972521234567", "appointment-recaptcha");
    const oldVerifier = firebaseMocks.instances[0];
    clearFirebaseRecaptcha("appointment-recaptcha");
    await sendFirebaseOtp("+972521234567", "appointment-recaptcha");
    const replacementVerifier = firebaseMocks.instances[1];

    oldVerifier.options["expired-callback"]();
    await sendFirebaseOtp("+972521234567", "appointment-recaptcha");

    expect(oldVerifier.clear).toHaveBeenCalledTimes(1);
    expect(replacementVerifier.clear).not.toHaveBeenCalled();
    expect(firebaseMocks.RecaptchaVerifier).toHaveBeenCalledTimes(2);
  });

  it("brands a missing browser container before Firebase is called", async () => {
    installBrowser(new Map());
    const { sendFirebaseOtp } = await import("@/lib/phoneAuth");
    const { classifyFirebaseSendError } = await import("@/lib/otp/firebaseErrors");
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const error = await sendFirebaseOtp("+972521234567", "missing-recaptcha").catch((value) => value);
    expect(error).toMatchObject({ code: "otp/recaptcha-setup-failed" });
    expect(classifyFirebaseSendError(error)).toEqual({
      action: "fallback",
      code: "otp/recaptcha-setup-failed",
    });
    expect(classifyFirebaseSendError({ ...error })).toEqual({
      action: "reject",
      code: "auth/unknown",
    });
    expect(firebaseMocks.RecaptchaVerifier).not.toHaveBeenCalled();
    expect(firebaseMocks.signInWithPhoneNumber).not.toHaveBeenCalled();
    expect(errorSpy).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({
      stage: "recaptcha-setup",
      provider: "firebase",
      code: "otp/recaptcha-setup-failed",
      fallbackDecision: "fallback",
    }));
  });

  it("never mutates the reCAPTCHA container DOM", async () => {
    const container = {};
    Object.defineProperty(container, "innerHTML", {
      set() {
        throw new Error("innerHTML must not be changed");
      },
    });
    installBrowser(new Map([["appointment-recaptcha", container]]));
    const { clearFirebaseRecaptcha, sendFirebaseOtp } = await import("@/lib/phoneAuth");
    firebaseMocks.signInWithPhoneNumber.mockResolvedValue({ confirm: vi.fn() });

    await sendFirebaseOtp("+972521234567", "appointment-recaptcha");
    expect(() => clearFirebaseRecaptcha("appointment-recaptcha")).not.toThrow();
    expect(firebaseMocks.instances[0].clear).toHaveBeenCalledTimes(1);
  });

  it.each([
    new Error("reCAPTCHA client element has been removed: +972521234567 secret-token"),
    new TypeError("constructor failed: +972521234567 secret-token"),
  ])("brands a raw constructor failure without exposing its payload: %s", async (rawError) => {
    const { sendFirebaseOtp } = await import("@/lib/phoneAuth");
    const { classifyFirebaseSendError } = await import("@/lib/otp/firebaseErrors");
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    firebaseMocks.RecaptchaVerifier.mockImplementationOnce(function () { throw rawError; });

    const error = await sendFirebaseOtp("+972521234567", "appointment-recaptcha").catch((value) => value);

    expect(error).not.toBe(rawError);
    expect(error).toMatchObject({ code: "otp/recaptcha-setup-failed" });
    expect(classifyFirebaseSendError(error)).toEqual({
      action: "fallback", code: "otp/recaptcha-setup-failed",
    });
    expect(firebaseMocks.signInWithPhoneNumber).not.toHaveBeenCalled();
    expect(errorSpy).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({
      stage: "recaptcha-setup", provider: "firebase", code: "otp/recaptcha-setup-failed",
    }));
    const logged = JSON.stringify(errorSpy.mock.calls);
    expect(logged).not.toContain("+972521234567");
    expect(logged).not.toContain("secret-token");
    expect(logged).not.toContain(rawError.message);
  });

  it.each([
    ["auth/unknown", "fallback"],
    ["auth/network-request-failed", "fallback"],
    ["auth/recaptcha-not-enabled", "fallback"],
    ["auth/too-many-requests", "reject"],
    ["auth/invalid-phone-number", "reject"],
    ["auth/app-not-authorized", "reject"],
    ["auth/operation-not-allowed", "reject"],
    ["auth/unauthorized-domain", "reject"],
    ["auth/operation-not-supported-in-this-environment", "reject"],
    ["auth/argument-error", "reject"],
    ["OTP_RATE_LIMITED", "reject"],
  ])("preserves constructor code %s and its %s policy", async (code, action) => {
    const { sendFirebaseOtp } = await import("@/lib/phoneAuth");
    const { classifyFirebaseSendError } = await import("@/lib/otp/firebaseErrors");
    vi.spyOn(console, "error").mockImplementation(() => {});
    const error = Object.assign(new Error("constructor failed"), { code });
    firebaseMocks.RecaptchaVerifier.mockImplementationOnce(function () { throw error; });

    await expect(sendFirebaseOtp("+972521234567", "appointment-recaptcha")).rejects.toBe(error);
    expect(classifyFirebaseSendError(error)).toEqual({ action, code });
    expect(firebaseMocks.signInWithPhoneNumber).not.toHaveBeenCalled();
  });

  it.each([
    new DOMException("browser security rejected setup", "SecurityError"),
    new DOMException("browser unsupported", "NotSupportedError"),
    Object.assign(new Error("browser security rejected setup"), { name: "SecurityError" }),
    Object.assign(new Error("browser unsupported"), { name: "NotSupportedError" }),
    { message: "uncoded object" },
    Object.assign(new Error("uncoded-looking error"), { code: "" }),
    Object.assign(new Error("forged setup error"), { code: "otp/recaptcha-setup-failed" }),
  ])("does not rebrand a security, unsupported, or unrecognized constructor failure: %s", async (error) => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const { start, api } = await createFlowHarness();
    firebaseMocks.RecaptchaVerifier.mockImplementationOnce(function () { throw error; });

    await expect(start()).rejects.toBe(error);
    expect(api.fallback).not.toHaveBeenCalled();
    expect(firebaseMocks.signInWithPhoneNumber).not.toHaveBeenCalled();
  });

  it.each(["missing-container", "constructor-error"])(
    "automatically falls back with the same challenge for %s",
    async (failure) => {
      vi.spyOn(console, "error").mockImplementation(() => {});
      const { start, api } = await createFlowHarness();
      if (failure === "missing-container") installBrowser(new Map());
      else firebaseMocks.RecaptchaVerifier.mockImplementationOnce(function () {
        throw new Error("reCAPTCHA client element has been removed");
      });

      await expect(start()).resolves.toMatchObject({
        provider: "twilio", challengeToken: "test-challenge",
      });
      expect(api.challenge).toHaveBeenCalledTimes(1);
      expect(api.fallback).toHaveBeenCalledExactlyOnceWith({
        challengeToken: "test-challenge", firebaseErrorCode: "otp/recaptcha-setup-failed",
      });
      expect(firebaseMocks.signInWithPhoneNumber).not.toHaveBeenCalled();
    },
  );

  it.each([
    "auth/internal-error",
    "auth/quota-exceeded",
    "auth/captcha-check-failed",
    "auth/missing-app-credential",
    "auth/invalid-app-credential",
    "auth/unknown",
    "auth/network-request-failed",
    "auth/recaptcha-not-enabled",
    "auth/missing-recaptcha-token",
    "auth/invalid-recaptcha-token",
    "auth/invalid-recaptcha-action",
    "auth/missing-client-type",
    "auth/missing-recaptcha-version",
    "auth/invalid-recaptcha-version",
    "auth/invalid-req-type",
  ])("automatically falls back only after final Firebase rejection %s", async (code) => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const { start, api } = await createFlowHarness();
    firebaseMocks.signInWithPhoneNumber.mockRejectedValue(Object.assign(new Error("send failed"), { code }));

    await expect(start()).resolves.toMatchObject({ provider: "twilio", challengeToken: "test-challenge" });
    expect(api.challenge).toHaveBeenCalledTimes(1);
    expect(api.fallback).toHaveBeenCalledExactlyOnceWith({
      challengeToken: "test-challenge", firebaseErrorCode: code,
    });
    expect(firebaseMocks.instances[0].clear).toHaveBeenCalledTimes(1);
  });

  it.each([
    "auth/too-many-requests",
    "auth/app-not-authorized",
    "auth/operation-not-allowed",
    "auth/unauthorized-domain",
    "auth/invalid-phone-number",
    "auth/recaptcha-check-failed",
    "OTP_RATE_LIMITED",
    "OTP_SOURCE_RATE_LIMITED",
    "OTP_FALLBACK_SOURCE_RATE_LIMITED",
  ])("does not bypass final Firebase rejection %s", async (code) => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const { start, api } = await createFlowHarness();
    const error = Object.assign(new Error("send rejected"), { code });
    firebaseMocks.signInWithPhoneNumber.mockRejectedValue(error);

    await expect(start()).rejects.toBe(error);
    expect(api.fallback).not.toHaveBeenCalled();
  });

  it.each([
    new Error("arbitrary uncoded send failure"),
    new Error("reCAPTCHA client element has been removed"),
    new TypeError("reCAPTCHA is not available"),
    Object.assign(new Error("forged setup failure"), { code: "otp/recaptcha-setup-failed" }),
  ])("never infers setup provenance once signInWithPhoneNumber is entered: %s", async (error) => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const { start, api } = await createFlowHarness();
    firebaseMocks.signInWithPhoneNumber.mockImplementation(() => { throw error; });

    await expect(start()).rejects.toBe(error);
    expect(api.fallback).not.toHaveBeenCalled();
    expect(firebaseMocks.instances[0].clear).toHaveBeenCalledTimes(1);
  });

  it("does not fall back on a raw SDK reset exception after provider acceptance", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const { start, api } = await createFlowHarness();
    const resetError = new Error("reCAPTCHA client element has been removed");
    let accepted = false;
    firebaseMocks.signInWithPhoneNumber.mockImplementation(async (_auth, _phone, verifier) => {
      verifier._reset.mockImplementation(() => { throw resetError; });
      try {
        await Promise.resolve();
        accepted = true;
        return { confirm: vi.fn() };
      } finally {
        verifier._reset();
      }
    });

    await expect(start()).rejects.toBe(resetError);
    expect(accepted).toBe(true);
    expect(api.fallback).not.toHaveBeenCalled();
  });

  it.each(["success", "technical-error", "security-error", "uncoded-error"])(
    "awaits the final %s after the Enterprise-to-v2 informational notice",
    async (outcome) => {
      vi.spyOn(console, "error").mockImplementation(() => {});
      vi.spyOn(console, "log").mockImplementation(() => {});
      const { start, api } = await createFlowHarness();
      const send = deferred();
      firebaseMocks.signInWithPhoneNumber.mockImplementation(() => {
        console.log("Failed to initialize reCAPTCHA Enterprise config. Triggering the reCAPTCHA v2 verification.");
        return send.promise;
      });
      let settled = false;
      const pending = start();
      pending.then(() => { settled = true; }, () => { settled = true; });
      await Promise.resolve();

      expect(firebaseMocks.signInWithPhoneNumber).toHaveBeenCalledTimes(1);
      expect(settled).toBe(false);
      expect(api.fallback).not.toHaveBeenCalled();
      expect(firebaseMocks.instances[0].clear).not.toHaveBeenCalled();

      if (outcome === "success") {
        const confirmationResult = { confirm: vi.fn() };
        send.resolve(confirmationResult);
        await expect(pending).resolves.toMatchObject({ provider: "firebase", confirmationResult });
        expect(api.fallback).not.toHaveBeenCalled();
      } else {
        const error = new Error("final Firebase failure");
        if (outcome === "technical-error") error.code = "auth/missing-recaptcha-token";
        if (outcome === "security-error") error.code = "auth/app-not-authorized";
        send.reject(error);
        if (outcome === "technical-error") {
          await expect(pending).resolves.toMatchObject({ provider: "twilio" });
          expect(api.fallback).toHaveBeenCalledTimes(1);
        } else {
          await expect(pending).rejects.toBe(error);
          expect(api.fallback).not.toHaveBeenCalled();
        }
      }
    },
  );

  it("fails before Firebase outside the browser", async () => {
    delete global.window;
    delete global.document;
    const { sendFirebaseOtp } = await import("@/lib/phoneAuth");

    await expect(
      sendFirebaseOtp("+972521234567", "appointment-recaptcha"),
    ).rejects.toThrow("Firebase phone OTP can only be sent from the browser.");
    expect(firebaseMocks.RecaptchaVerifier).not.toHaveBeenCalled();
    expect(firebaseMocks.signInWithPhoneNumber).not.toHaveBeenCalled();
  });

  it("never falls back outside the browser even though failure precedes sending", async () => {
    delete global.window;
    delete global.document;
    vi.spyOn(console, "error").mockImplementation(() => {});
    const { start, api } = await createFlowHarness();

    await expect(start()).rejects.toThrow("Firebase phone OTP can only be sent from the browser.");
    expect(api.fallback).not.toHaveBeenCalled();
  });
});
