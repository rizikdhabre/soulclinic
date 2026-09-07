import { beforeEach, describe, expect, it, vi } from "vitest";
import { OtpError } from "@/lib/otp/errors";

const mocks = vi.hoisted(() => ({
  requestTwilioFallback: vi.fn(),
}));

vi.mock("@/lib/otp/twilioFallback", () => ({
  requestTwilioFallback: mocks.requestTwilioFallback,
}));

import { POST as fallbackPost } from "@/app/api/otp/fallback/route";

function jsonRequest(path, body) {
  return new Request(`https://example.com${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("POST /api/otp/fallback", () => {
  it.each(["OTP_SEND_FAILED", "OTP_SEND_PENDING", "OTP_PROVIDER_REJECTED", "OTP_PERSISTENCE_FAILED", "OTP_CHALLENGE_EXPIRED"])(
    "preserves the reservation deadline on %s responses", async (code) => {
      const metadata = {
        retryAt: "2026-08-23T12:01:00.000Z", serverTime: "2026-08-23T12:00:09.000Z",
        restrictionScope: "phone", correlationId: "061a1297-e394-40a2-9e22-fc63b2c186a1", retryAfterSeconds: 51,
      };
      mocks.requestTwilioFallback.mockRejectedValue(Object.assign(new OtpError(code, 503, "secret"), metadata));
      const response = await fallbackPost(jsonRequest("/api/otp/fallback", { challengeToken: "public-token", firebaseErrorCode: "auth/internal-error" }));
      const body = await response.json();
      expect(response.status).toBe(503);
      expect(body).toMatchObject({ error: code, ...metadata });
      expect(JSON.stringify(body)).not.toContain("secret");
    },
  );

  it("includes both source and phone deadlines when source protection is stronger", async () => {
    const metadata = {
      retryAt: "2026-08-23T12:10:00.000Z", phoneRetryAt: "2026-08-23T12:01:00.000Z",
      serverTime: "2026-08-23T12:00:09.000Z", retryAfterSeconds: 591, restrictionScope: "source",
    };
    mocks.requestTwilioFallback.mockRejectedValue(Object.assign(new OtpError("OTP_FALLBACK_SOURCE_RATE_LIMITED", 429, "secret"), metadata));
    const response = await fallbackPost(jsonRequest("/api/otp/fallback", { challengeToken: "public-token", firebaseErrorCode: "auth/internal-error" }));
    expect(await response.json()).toMatchObject(metadata);
  });

  beforeEach(() => {
    mocks.requestTwilioFallback.mockResolvedValue({
      provider: "twilio",
      status: "pending",
    });
  });

  it("passes the actual request and only accepted fields to the service", async () => {
    const request = jsonRequest("/api/otp/fallback", {
      challengeToken: "public-challenge-token",
      firebaseErrorCode: "auth/internal-error",
      phone: "+972599999999",
      sid: "caller-provider-id",
    });

    const response = await fallbackPost(request);

    expect(mocks.requestTwilioFallback).toHaveBeenCalledWith({
      request,
      challengeToken: "public-challenge-token",
      firebaseErrorCode: "auth/internal-error",
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ provider: "twilio", status: "pending" });
  });

  it.each([
    ["malformed JSON", "{not-json"],
    ["missing fields", JSON.stringify({ challengeToken: "" })],
  ])("returns a fixed safe 400 response for %s", async (_case, body) => {
    const request = new Request("https://example.com/api/otp/fallback", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
    });

    const response = await fallbackPost(request);

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: "OTP_FALLBACK_FAILED",
      message: "Failed to request OTP fallback.",
    });
    expect(mocks.requestTwilioFallback).not.toHaveBeenCalled();
  });

  it.each([
    [
      "OTP_FALLBACK_NOT_ALLOWED",
      400,
      "OTP fallback is not available for this request.",
    ],
    ["OTP_FALLBACK_ALREADY_USED", 409, "OTP fallback has already been requested."],
    ["OTP_SERVICE_NOT_CONFIGURED", 503, "OTP service is not configured."],
    [
      "OTP_SEND_PENDING",
      503,
      "The verification request may still be processing. Please wait before trying again.",
    ],
  ])("maps %s to a fixed safe response", async (code, status, message) => {
    mocks.requestTwilioFallback.mockRejectedValue(
      new OtpError(code, status, "private provider error message"),
    );

    const response = await fallbackPost(
      jsonRequest("/api/otp/fallback", {
        challengeToken: "public-challenge-token",
        firebaseErrorCode: "auth/internal-error",
      }),
    );
    const body = await response.json();

    expect(response.status).toBe(status);
    expect(body).toEqual({ error: code, message });
    expect(JSON.stringify(body)).not.toContain("private provider error message");
  });

  it("preserves the source fallback retry interval", async () => {
    mocks.requestTwilioFallback.mockRejectedValue(
      new OtpError(
        "OTP_FALLBACK_SOURCE_RATE_LIMITED",
        429,
        "private source detail",
        37,
      ),
    );

    const response = await fallbackPost(
      jsonRequest("/api/otp/fallback", {
        challengeToken: "public-challenge-token",
        firebaseErrorCode: "auth/internal-error",
      }),
    );

    expect(response.status).toBe(429);
    expect(await response.json()).toEqual({
      error: "OTP_FALLBACK_SOURCE_RATE_LIMITED",
      message: "OTP fallback rate limit exceeded.",
      retryAfterSeconds: 37,
    });
  });

  it("projects success without provider or request leakage", async () => {
    mocks.requestTwilioFallback.mockResolvedValue({
      provider: "twilio",
      status: "pending",
      sid: "provider-secret-id",
      body: "provider-secret-body",
      phone: "+972521234567",
      message: "provider error message",
      challengeToken: "public-challenge-token",
    });

    const response = await fallbackPost(
      jsonRequest("/api/otp/fallback", {
        challengeToken: "public-challenge-token",
        firebaseErrorCode: "auth/internal-error",
      }),
    );
    const body = await response.json();

    expect(body).toEqual({ provider: "twilio", status: "pending" });
    expect(JSON.stringify(body)).not.toMatch(
      /provider-secret|\+972521234567|provider error|public-challenge-token/,
    );
  });

  it("returns a fixed safe 500 response for unexpected failures", async () => {
    mocks.requestTwilioFallback.mockRejectedValue(
      Object.assign(new Error("raw provider failure"), {
        sid: "provider-secret-id",
        body: "provider-secret-body",
      }),
    );

    const response = await fallbackPost(
      jsonRequest("/api/otp/fallback", {
        challengeToken: "public-challenge-token",
        firebaseErrorCode: "auth/internal-error",
      }),
    );

    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({
      error: "OTP_FALLBACK_FAILED",
      message: "Failed to request OTP fallback.",
    });
  });
});
