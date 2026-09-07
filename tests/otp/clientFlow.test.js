import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  completeOtpClientFlow,
  createOtpApiClient,
  startOtpClientFlow,
} from "@/lib/otp/client";
import { FirebaseRecaptchaSetupError } from "@/lib/otp/firebaseSetupError";

function createApi() {
  return {
    challenge: vi.fn().mockResolvedValue({
      challengeToken: "challenge-token",
      provider: "firebase",
      expiresAt: "2026-08-23T20:00:00.000Z",
      retryAfterSeconds: 60,
    }),
    fallback: vi.fn().mockResolvedValue({
      provider: "twilio",
      retryAfterSeconds: 60,
    }),
    complete: vi.fn().mockResolvedValue({ success: true, purpose: "booking" }),
  };
}

describe("createOtpApiClient", () => {
  it("posts only the supplied payload to each OTP endpoint", async () => {
    const http = {
      post: vi
        .fn()
        .mockResolvedValueOnce({ data: { provider: "firebase" } })
        .mockResolvedValueOnce({ data: { provider: "twilio" } })
        .mockResolvedValueOnce({ data: { success: true } }),
    };
    const api = createOtpApiClient(http);

    await expect(api.challenge({ phone: "+972521234567", purpose: "booking" })).resolves.toEqual({
      provider: "firebase",
    });
    await expect(
      api.fallback({ challengeToken: "challenge-token", firebaseErrorCode: "auth/internal-error" }),
    ).resolves.toEqual({ provider: "twilio" });
    await expect(
      api.complete({ challengeToken: "challenge-token", provider: "development", code: "654321" }),
    ).resolves.toEqual({ success: true });

    expect(http.post.mock.calls).toEqual([
      ["/api/otp/challenge", { phone: "+972521234567", purpose: "booking" }],
      [
        "/api/otp/fallback",
        { challengeToken: "challenge-token", firebaseErrorCode: "auth/internal-error" },
      ],
      [
        "/api/otp/complete",
        { challengeToken: "challenge-token", provider: "development", code: "654321" },
      ],
    ]);
  });
});

describe("startOtpClientFlow", () => {
  let api;

  beforeEach(() => {
    api = createApi();
  });

  it("obtains a backend challenge before sending Firebase OTP", async () => {
    const order = [];
    api.challenge.mockImplementation(async () => {
      order.push("challenge");
      return {
        challengeToken: "challenge-token",
        provider: "firebase",
        expiresAt: "2026-08-23T20:00:00.000Z",
        retryAfterSeconds: 60,
      };
    });
    const confirmationResult = { confirm: vi.fn() };
    const sendFirebaseOtp = vi.fn(async () => {
      order.push("firebase");
      return confirmationResult;
    });

    const flow = await startOtpClientFlow({
      phone: "+972521234567",
      purpose: "booking",
      containerId: "appointment-recaptcha",
      api,
      sendFirebaseOtp,
      clearFirebaseRecaptcha: vi.fn(),
    });

    expect(order).toEqual(["challenge", "firebase"]);
    expect(api.challenge).toHaveBeenCalledWith({
      phone: "+972521234567",
      purpose: "booking",
    });
    expect(sendFirebaseOtp).toHaveBeenCalledWith(
      "+972521234567",
      "appointment-recaptcha",
    );
    expect(flow).toEqual({
      challengeToken: "challenge-token",
      provider: "firebase",
      expiresAt: "2026-08-23T20:00:00.000Z",
      retryAfterSeconds: 60,
      confirmationResult,
    });
  });

  it("returns a development code-entry flow without calling Firebase", async () => {
    api.challenge.mockResolvedValue({
      challengeToken: "development-token",
      provider: "development",
      expiresAt: "2026-08-23T20:00:00.000Z",
      retryAfterSeconds: 42,
    });
    const sendFirebaseOtp = vi.fn();

    await expect(
      startOtpClientFlow({
        phone: "+972521234567",
        purpose: "login",
        containerId: "login-recaptcha",
        api,
        sendFirebaseOtp,
        clearFirebaseRecaptcha: vi.fn(),
      }),
    ).resolves.toEqual({
      challengeToken: "development-token",
      provider: "development",
      expiresAt: "2026-08-23T20:00:00.000Z",
      retryAfterSeconds: 42,
    });
    expect(sendFirebaseOtp).not.toHaveBeenCalled();
    expect(api.fallback).not.toHaveBeenCalled();
  });

  it.each([
    "auth/internal-error",
    "auth/captcha-check-failed",
    "auth/invalid-app-credential",
    "auth/missing-app-credential",
    "auth/network-request-failed",
    "auth/unknown",
    "auth/quota-exceeded",
    "auth/recaptcha-not-enabled",
    "auth/missing-recaptcha-token",
    "auth/invalid-recaptcha-token",
    "auth/invalid-recaptcha-action",
    "auth/missing-client-type",
    "auth/missing-recaptcha-version",
    "auth/invalid-recaptcha-version",
    "auth/invalid-req-type",
  ])("requests fallback once for eligible Firebase SEND failure %s", async (code) => {
    const firebaseError = Object.assign(new Error("send failed"), {
      code,
    });
    const clearFirebaseRecaptcha = vi.fn();

    const flow = await startOtpClientFlow({
      phone: "+972521234567",
      purpose: "booking",
      containerId: "appointment-recaptcha",
      api,
      sendFirebaseOtp: vi.fn().mockRejectedValue(firebaseError),
      clearFirebaseRecaptcha,
    });

    expect(clearFirebaseRecaptcha).toHaveBeenCalledTimes(1);
    expect(clearFirebaseRecaptcha).toHaveBeenCalledWith("appointment-recaptcha");
    expect(api.fallback).toHaveBeenCalledTimes(1);
    expect(api.challenge).toHaveBeenCalledTimes(1);
    expect(api.fallback).toHaveBeenCalledWith({
      challengeToken: "challenge-token",
      firebaseErrorCode: code,
    });
    expect(flow).toEqual({
      challengeToken: "challenge-token",
      provider: "twilio",
      expiresAt: "2026-08-23T20:00:00.000Z",
      retryAfterSeconds: 60,
    });
  });

  it("projects fallback output without retaining unrelated response fields", async () => {
    api.fallback.mockResolvedValue({
      provider: "twilio",
      retryAfterSeconds: 30,
      phone: "+972521234567",
      providerPayload: { sid: "provider-secret" },
    });

    const flow = await startOtpClientFlow({
      phone: "+972521234567",
      purpose: "booking",
      containerId: "appointment-recaptcha",
      api,
      sendFirebaseOtp: vi.fn().mockRejectedValue(
        Object.assign(new Error("send failed"), { code: "auth/internal-error" }),
      ),
      clearFirebaseRecaptcha: vi.fn(),
    });

    expect(flow).toEqual({
      challengeToken: "challenge-token",
      provider: "twilio",
      expiresAt: "2026-08-23T20:00:00.000Z",
      retryAfterSeconds: 30,
    });
  });

  it("falls back for a branded pre-send setup failure, not a copied code or arbitrary exception", async () => {
    for (const failure of [
      new FirebaseRecaptchaSetupError(),
      Object.assign(new Error("reCAPTCHA setup failed"), { code: "otp/recaptcha-setup-failed" }),
      new Error("reCAPTCHA client element has been removed: 0"),
      new TypeError("callback assignment failed"),
    ]) {
      const testApi = createApi();
      const promise = startOtpClientFlow({
        phone: "+972521234567", purpose: "booking", containerId: "appointment-recaptcha",
        api: testApi, sendFirebaseOtp: vi.fn().mockRejectedValue(failure), clearFirebaseRecaptcha: vi.fn(),
      });
      if (failure instanceof FirebaseRecaptchaSetupError) {
        await expect(promise).resolves.toMatchObject({ provider: "twilio" });
        expect(testApi.fallback).toHaveBeenCalledExactlyOnceWith({
          challengeToken: "challenge-token", firebaseErrorCode: "otp/recaptcha-setup-failed",
        });
      } else {
        await expect(promise).rejects.toBe(failure);
        expect(testApi.fallback).not.toHaveBeenCalled();
      }
    }
  });

  it.each([
    "auth/too-many-requests",
    "auth/invalid-phone-number",
  ])("preserves the original %s error without requesting fallback", async (code) => {
    const firebaseError = Object.assign(new Error(code), { code });
    const clearFirebaseRecaptcha = vi.fn();

    await expect(
      startOtpClientFlow({
        phone: "+972521234567",
        purpose: "booking",
        containerId: "appointment-recaptcha",
        api,
        sendFirebaseOtp: vi.fn().mockRejectedValue(firebaseError),
        clearFirebaseRecaptcha,
      }),
    ).rejects.toBe(firebaseError);
    expect(api.fallback).not.toHaveBeenCalled();
    expect(clearFirebaseRecaptcha).not.toHaveBeenCalled();
  });
});

describe("completeOtpClientFlow", () => {
  it("never falls back or completes when Firebase code confirmation fails", async () => {
    const log = vi.spyOn(console, "info").mockImplementation(() => {});
    const api = createApi();
    const firebaseError = Object.assign(new Error("wrong code"), {
      code: "auth/invalid-verification-code",
    });
    const flow = {
      challengeToken: "challenge-token",
      correlationId: "00000000-0000-4000-8000-000000000001",
      provider: "firebase",
      confirmationResult: {
        confirm: vi.fn().mockRejectedValue(firebaseError),
      },
    };

    await expect(completeOtpClientFlow({ flow, code: "000000", api })).rejects.toBe(
      firebaseError,
    );
    expect(api.fallback).not.toHaveBeenCalled();
    expect(api.complete).not.toHaveBeenCalled();
    expect(flow.confirmationResult).toBeTruthy();
    expect(log).toHaveBeenCalledWith("OTP flow", {
      correlationId: flow.correlationId, stage: "complete", provider: "firebase",
      decision: "failed", errorCode: "auth/invalid-verification-code",
    });
    log.mockRestore();
  });

  it("sends only a transient Firebase ID token and drops the confirmation on success", async () => {
    const api = createApi();
    const getIdToken = vi.fn().mockResolvedValue("firebase-id-token");
    const flow = {
      challengeToken: "challenge-token",
      provider: "firebase",
      confirmationResult: {
        confirm: vi.fn().mockResolvedValue({ user: { getIdToken } }),
      },
    };

    await expect(completeOtpClientFlow({ flow, code: "654321", api })).resolves.toEqual({
      success: true,
      purpose: "booking",
    });
    expect(api.complete).toHaveBeenCalledWith({
      challengeToken: "challenge-token",
      provider: "firebase",
      idToken: "firebase-id-token",
    });
    expect(flow.confirmationResult).toBeNull();
  });

  it.each(["twilio", "development"])(
    "submits only challenge, provider, and code for %s completion",
    async (provider) => {
      const api = createApi();

      await completeOtpClientFlow({
        flow: {
          challengeToken: "challenge-token",
          provider,
          phone: "+972521234567",
          purpose: "booking",
        },
        code: "654321",
        api,
      });

      expect(api.complete).toHaveBeenCalledWith({
        challengeToken: "challenge-token",
        provider,
        code: "654321",
      });
    },
  );

  it("rejects an unsupported completion provider before calling the API", async () => {
    const api = createApi();

    await expect(
      completeOtpClientFlow({
        flow: { challengeToken: "challenge-token", provider: "unknown" },
        code: "654321",
        api,
      }),
    ).rejects.toMatchObject({ code: "OTP_PROVIDER_UNSUPPORTED" });
    expect(api.complete).not.toHaveBeenCalled();
  });
});
