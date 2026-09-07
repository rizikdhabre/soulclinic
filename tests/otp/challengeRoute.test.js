import { beforeEach, describe, expect, it, vi } from "vitest";
import { OtpError } from "@/lib/otp/errors";

const { createOtpChallengeMock } = vi.hoisted(() => ({
  createOtpChallengeMock: vi.fn(),
}));

vi.mock("@/lib/otp/challengeService", () => ({
  createOtpChallenge: createOtpChallengeMock,
}));

import { POST } from "@/app/api/otp/challenge/route";

function jsonRequest(body) {
  return new Request("https://example.com/api/otp/challenge", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("POST /api/otp/challenge", () => {
  it("projects only bounded error timing metadata and a UUID correlation", async () => {
    createOtpChallengeMock.mockRejectedValue(Object.assign(new OtpError("OTP_RATE_LIMITED", 429, "private"), {
      retryAfterSeconds: Infinity, retryAt: "private-token", serverTime: "raw-provider-body",
      phoneRetryAt: "+972521234567", correlationId: "private-token", restrictionScope: "private-source",
    }));
    const response = await POST(jsonRequest({ phone: "0521234567", purpose: "booking" }));
    expect(await response.json()).toEqual({ error: "OTP_RATE_LIMITED", message: "OTP request rate limit exceeded." });
  });

  it.each(["phone", "source"])("preserves %s restriction deadlines and correlation without error details", async (restrictionScope) => {
    const metadata = {
      retryAt: "2026-08-23T12:01:00.000Z", serverTime: "2026-08-23T12:00:09.000Z",
      restrictionScope, correlationId: "061a1297-e394-40a2-9e22-fc63b2c186a1", retryAfterSeconds: 51,
    };
    const code = restrictionScope === "phone" ? "OTP_RATE_LIMITED" : "OTP_SOURCE_RATE_LIMITED";
    createOtpChallengeMock.mockRejectedValue(Object.assign(new OtpError(code, 429, "secret"), metadata, { phone: "private-phone" }));
    const response = await POST(jsonRequest({ phone: "0521234567", purpose: "booking" }));
    const body = await response.json();
    expect(response.status).toBe(429);
    expect(body).toMatchObject({ error: code, ...metadata });
    expect(JSON.stringify(body)).not.toMatch(/secret|private-phone/);
  });

  beforeEach(() => {
    createOtpChallengeMock.mockResolvedValue({
      challengeToken: "public-challenge-token",
      provider: "firebase",
      expiresAt: new Date("2026-08-23T12:10:00.000Z"),
      retryAfterSeconds: 60,
    });
  });

  it("passes the actual Request and only accepted fields to the service", async () => {
    const request = jsonRequest({
      phone: "0521234567",
      purpose: "booking",
      sourceHash: "caller-controlled",
      exists: true,
    });

    const response = await POST(request);

    expect(createOtpChallengeMock).toHaveBeenCalledWith({
      request,
      phone: "0521234567",
      purpose: "booking",
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      challengeToken: "public-challenge-token",
      provider: "firebase",
      expiresAt: "2026-08-23T12:10:00.000Z",
      retryAfterSeconds: 60,
    });
  });

  it("returns a fixed safe 400 response for malformed JSON", async () => {
    const request = new Request("https://example.com/api/otp/challenge", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{not-json",
    });

    const response = await POST(request);

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: "OTP_CHALLENGE_FAILED",
      message: "Failed to create OTP challenge.",
    });
    expect(createOtpChallengeMock).not.toHaveBeenCalled();
  });

  it.each([
    ["INVALID_PHONE", "Invalid phone number."],
    ["INVALID_OTP_PURPOSE", "Invalid OTP purpose."],
  ])("maps %s to a fixed safe 400 response", async (code, message) => {
    createOtpChallengeMock.mockRejectedValue(new OtpError(code, 400, "private detail"));

    const response = await POST(jsonRequest({ phone: "bad", purpose: "bad" }));
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body).toEqual({ error: code, message });
    expect(JSON.stringify(body)).not.toContain("private detail");
  });

  it.each([
    ["OTP_RATE_LIMITED", "OTP request rate limit exceeded."],
    ["OTP_SOURCE_RATE_LIMITED", "OTP challenge rate limit exceeded."],
  ])("preserves %s status and retry interval", async (code, message) => {
    createOtpChallengeMock.mockRejectedValue(
      new OtpError(code, 429, "private rate detail", 37),
    );

    const response = await POST(jsonRequest({ phone: "0521234567", purpose: "booking" }));

    expect(response.status).toBe(429);
    expect(await response.json()).toEqual({
      error: code,
      message,
      retryAfterSeconds: 37,
    });
  });

  it("preserves a safe source-unavailable response", async () => {
    createOtpChallengeMock.mockRejectedValue(
      new OtpError("OTP_SOURCE_UNAVAILABLE", 503, "private ingress detail"),
    );

    const response = await POST(jsonRequest({ phone: "0521234567", purpose: "login" }));

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({
      error: "OTP_SOURCE_UNAVAILABLE",
      message: "OTP source identity is unavailable.",
    });
  });

  it("returns a fixed safe 500 response for unexpected failures", async () => {
    const error = Object.assign(new Error("provider secret body"), {
      stack: "private stack",
      provider: "twilio",
      token: "private-token",
    });
    createOtpChallengeMock.mockRejectedValue(error);

    const response = await POST(jsonRequest({ phone: "0521234567", purpose: "booking" }));
    const body = await response.json();

    expect(response.status).toBe(500);
    expect(body).toEqual({
      error: "OTP_CHALLENGE_FAILED",
      message: "Failed to create OTP challenge.",
    });
    expect(JSON.stringify(body)).not.toMatch(/provider secret|private stack|twilio|private-token/);
  });
});
