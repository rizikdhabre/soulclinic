import { beforeEach, describe, expect, it, vi } from "vitest";

const { completeOtpChallenge } = vi.hoisted(() => ({
  completeOtpChallenge: vi.fn(),
}));

vi.mock("@/lib/otp/completionService", () => ({
  completeOtpChallenge,
}));

import { POST } from "@/app/api/otp/complete/route";
import { POST as logoutCustomer } from "@/app/api/customer/logout/route";

function request(body) {
  return new Request("http://localhost/api/otp/complete", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function responseBody(response) {
  return JSON.parse(await response.text());
}

describe("POST /api/otp/complete", () => {
  beforeEach(() => {
    completeOtpChallenge.mockReset();
    completeOtpChallenge.mockResolvedValue({
      success: true,
      purpose: "booking",
      verificationToken: "booking-grant",
      expiresInSeconds: 600,
      profile: { hasCompleteName: false },
      phone: "+972501234567",
      idToken: "transient-id-token",
      challengeToken: "challenge-token",
      sessionToken: "internal-session-token",
      sessionTtlSeconds: 3_600,
      providerRawData: { status: "approved" },
    });
  });

  it("selects only Firebase challenge, provider, and ID-token fields", async () => {
    const response = await POST(
      request({
        challengeToken: "challenge-token",
        provider: "firebase",
        idToken: "transient-id-token",
        code: "ignored-code",
        phone: "+972599999999",
        purpose: "login",
        arbitrary: "ignored",
      }),
    );

    expect(response.status).toBe(200);
    expect(completeOtpChallenge).toHaveBeenCalledWith({
      challengeToken: "challenge-token",
      provider: "firebase",
      idToken: "transient-id-token",
    });
  });

  it.each(["twilio", "development"])(
    "selects only %s challenge, provider, and code fields",
    async (provider) => {
      const response = await POST(
        request({
          challengeToken: "challenge-token",
          provider,
          code: "123123",
          idToken: "ignored-token",
          phone: "+972599999999",
          purpose: "login",
          arbitrary: "ignored",
        }),
      );

      expect(response.status).toBe(200);
      expect(completeOtpChallenge).toHaveBeenCalledWith({
        challengeToken: "challenge-token",
        provider,
        code: "123123",
      });
    },
  );

  it("returns only the minimized booking completion result", async () => {
    const response = await POST(
      request({
        challengeToken: "challenge-token",
        provider: "firebase",
        idToken: "transient-id-token",
      }),
    );
    const body = await responseBody(response);

    expect(body).toEqual({
      success: true,
      purpose: "booking",
      verificationToken: "booking-grant",
      expiresInSeconds: 600,
      profile: { hasCompleteName: false },
    });
    expect(JSON.stringify(body)).not.toMatch(
      /phone|idToken|challengeToken|sessionToken|sessionTtlSeconds|provider/i,
    );
    expect(response.cookies.getAll()).toEqual([]);
  });

  it("sets one HttpOnly customer cookie and returns only login success", async () => {
    completeOtpChallenge.mockResolvedValueOnce({
      purpose: "login",
      sessionToken: "internal-session-token",
      sessionTtlSeconds: 3_600,
      verificationToken: "must-not-cross-login-boundary",
      profile: { hasCompleteName: true, firstName: "Ada", lastName: "Lovelace" },
    });

    const response = await POST(
      request({
        challengeToken: "challenge-token",
        provider: "firebase",
        idToken: "transient-id-token",
      }),
    );
    const body = await responseBody(response);
    const cookies = response.cookies.getAll();

    expect(response.status).toBe(200);
    expect(body).toEqual({ success: true, purpose: "login" });
    expect(Object.keys(body)).toEqual(["success", "purpose"]);
    expect(cookies).toHaveLength(1);
    expect(cookies[0]).toMatchObject({
      name: "customer_session",
      value: "internal-session-token",
      httpOnly: true,
      secure: false,
      sameSite: "lax",
      path: "/",
      maxAge: 3_600,
    });
    expect(cookies.some(({ name }) => name === "token")).toBe(false);
  });

  it.each([
    ["OTP_EVIDENCE_REQUIRED", 400, "OTP evidence is required."],
    ["INVALID_FIREBASE_TOKEN", 401, "Invalid Firebase phone verification."],
    ["OTP_CHALLENGE_ALREADY_COMPLETED", 409, "OTP challenge is already completed."],
    ["OTP_VERIFY_RATE_LIMITED", 429, "OTP verification rate limit exceeded."],
    ["OTP_LOGIN_COMPLETION_UNAVAILABLE", 503, "OTP login completion is unavailable."],
  ])("maps %s to a fixed safe response", async (code, status, message) => {
    completeOtpChallenge.mockRejectedValue(
      Object.assign(new Error("raw secret provider detail"), {
        code,
        status: 418,
        providerErrorCode: "secret-provider-code",
        phone: "+972501234567",
      }),
    );

    const response = await POST(
      request({
        challengeToken: "challenge-token",
        provider: "firebase",
        idToken: "transient-id-token",
      }),
    );
    const body = await responseBody(response);

    expect(response.status).toBe(status);
    expect(body).toEqual({ success: false, error: { code, message } });
    expect(JSON.stringify(body)).not.toContain("raw secret provider detail");
    expect(JSON.stringify(body)).not.toContain("secret-provider-code");
    expect(JSON.stringify(body)).not.toContain("+972501234567");
    expect(response.cookies.getAll()).toEqual([]);
  });

  it("maps unknown failures without serializing arbitrary error details", async () => {
    completeOtpChallenge.mockRejectedValue(
      Object.assign(new Error("database topology and credential detail"), {
        code: "MONGO_RAW_FAILURE",
        status: 401,
        idToken: "transient-id-token",
      }),
    );

    const response = await POST(
      request({
        challengeToken: "challenge-token",
        provider: "firebase",
        idToken: "transient-id-token",
      }),
    );

    expect(response.status).toBe(500);
    expect(await responseBody(response)).toEqual({
      success: false,
      error: {
        code: "OTP_COMPLETION_FAILED",
        message: "OTP completion failed.",
      },
    });
  });

  it("maps malformed JSON to a fixed safe 400 response", async () => {
    const malformed = new Request("http://localhost/api/otp/complete", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{not-json",
    });

    const response = await POST(malformed);

    expect(response.status).toBe(400);
    expect(await responseBody(response)).toEqual({
      success: false,
      error: {
        code: "OTP_REQUEST_INVALID",
        message: "Invalid OTP completion request.",
      },
    });
    expect(completeOtpChallenge).not.toHaveBeenCalled();
  });
});

describe("POST /api/customer/logout", () => {
  it("returns success and expires only the customer session cookie", async () => {
    const response = await logoutCustomer();
    const cookies = response.cookies.getAll();

    expect(response.status).toBe(200);
    expect(await responseBody(response)).toEqual({ success: true });
    expect(cookies).toHaveLength(1);
    expect(cookies[0]).toMatchObject({
      name: "customer_session",
      value: "",
      maxAge: 0,
      path: "/",
    });
    expect(cookies.some(({ name }) => name === "token")).toBe(false);
  });
});
