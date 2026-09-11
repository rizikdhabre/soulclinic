import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { OtpError } from "@/lib/otp/errors";

const { completeOtpChallenge } = vi.hoisted(() => ({ completeOtpChallenge: vi.fn() }));
vi.mock("@/lib/otp/completionService", () => ({ completeOtpChallenge }));
import { POST } from "@/app/api/otp/complete/route";
import { POST as logoutCustomer } from "@/app/api/customer/logout/route";

const token = "a".repeat(43);
const grant = "b".repeat(43);
const valid = { challengeToken: token, purpose: "booking", code: "123456" };
const timing = {
  retryAt: "2026-08-23T12:10:00.000Z", serverTime: "2026-08-23T12:00:00.000Z",
  retryAfterSeconds: 600, restrictionScope: "phone", correlationId: "061a1297-e394-40a2-9e22-fc63b2c186a1",
};
function request(body = valid, raw = false) {
  return new Request("https://example.com/api/otp/complete", {
    method: "POST", headers: { "content-type": "application/json" }, body: raw ? body : JSON.stringify(body),
  });
}
function privateError(response) {
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect(response.cookies.getAll()).toEqual([]);
}

describe("POST /api/otp/complete", () => {
  beforeEach(() => {
    completeOtpChallenge.mockReset();
    completeOtpChallenge.mockResolvedValue({
      success: true, purpose: "booking", verificationToken: grant, expiresInSeconds: 600,
      profile: { hasCompleteName: true, firstName: "Ada", lastName: "Lovelace", email: "private-email" },
      phone: "private-phone", challengeToken: "private-challenge", sessionToken: "private-session",
      sessionTtlSeconds: 3600, providerRawData: { status: "approved" }, recoveryReceipt: "private-receipt",
    });
  });
  afterEach(() => vi.unstubAllEnvs());

  it.each([undefined, "opaque-recovery", "r".repeat(2048)])("forwards purpose, code and optional receipt %j only", async (recoveryReceipt) => {
    const payload = { ...valid, ...(recoveryReceipt === undefined ? {} : { recoveryReceipt }) };
    const response = await POST(request({ ...payload, phone: "ignored-phone", provider: "ignored", success: true, request: "ignored" }));
    expect(completeOtpChallenge).toHaveBeenCalledExactlyOnceWith(payload);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      success: true, purpose: "booking", verificationToken: grant, expiresInSeconds: 600,
      profile: { hasCompleteName: true, firstName: "Ada", lastName: "Lovelace" },
    });
    privateError(response);
  });

  it("allows receipt-only recovery without requiring a new verification code", async () => {
    const response = await POST(request({ challengeToken: token, purpose: "booking", recoveryReceipt: "opaque-recovery" }));
    expect(response.status).toBe(200);
    expect(completeOtpChallenge).toHaveBeenCalledExactlyOnceWith({ challengeToken: token, purpose: "booking", code: undefined, recoveryReceipt: "opaque-recovery" });
  });

  it.each([undefined, ""])("forwards an empty replay code %j without requiring a receipt", async (code) => {
    const response = await POST(request({ ...valid, code }));
    expect(response.status).toBe(200);
    expect(completeOtpChallenge).toHaveBeenCalledExactlyOnceWith({ ...valid, code });
    expect(await response.json()).toMatchObject({ success: true, purpose: "booking", verificationToken: grant });
    privateError(response);
  });

  it.each([undefined, ""])("preserves the service rejection of an unapproved replay with code %j", async (code) => {
    completeOtpChallenge.mockRejectedValue(new OtpError("INVALID_OTP", 401, "private-detail"));
    const response = await POST(request({ ...valid, code }));
    expect(completeOtpChallenge).toHaveBeenCalledExactlyOnceWith({ ...valid, code });
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ success: false, error: { code: "INVALID_OTP", message: "Invalid verification code." } });
    privateError(response);
  });

  it("returns only the incomplete-profile flag when names are not available", async () => {
    completeOtpChallenge.mockResolvedValue({ purpose: "booking", verificationToken: grant, expiresInSeconds: 600, profile: { hasCompleteName: false, firstName: "private-name" } });
    const response = await POST(request());
    expect((await response.json()).profile).toEqual({ hasCompleteName: false });
    privateError(response);
  });

  it.each(["production", "test"])("sets a deterministic HttpOnly cookie in %s and never exposes the session token", async (environment) => {
    vi.stubEnv("NODE_ENV", environment);
    completeOtpChallenge.mockResolvedValue({ purpose: "login", sessionToken: "signed-session", sessionTtlSeconds: 3210, verificationToken: "private-grant", profile: { firstName: "private-name" } });
    for (let retry = 0; retry < 2; retry += 1) {
      const response = await POST(request({ ...valid, purpose: "login" }));
      expect(await response.json()).toEqual({ success: true, purpose: "login" });
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect(response.cookies.getAll()).toHaveLength(1);
      expect(response.cookies.get("customer_session")).toMatchObject({ value: "signed-session", httpOnly: true, secure: environment === "production", sameSite: "lax", path: "/", maxAge: 3210 });
      expect(response.headers.get("set-cookie")).toContain("HttpOnly");
    }
    expect(completeOtpChallenge).toHaveBeenCalledWith({ ...valid, purpose: "login" });
  });

  it.each([undefined, null, 0, -1, 1.5, "3600"])("does not invent a cookie lifetime for malformed service TTL %j", async (sessionTtlSeconds) => {
    completeOtpChallenge.mockResolvedValue({ purpose: "login", sessionToken: "signed-session", sessionTtlSeconds });
    const response = await POST(request({ ...valid, purpose: "login" }));
    expect(response.status).toBe(500);
    expect((await response.json()).error.code).toBe("OTP_COMPLETION_FAILED");
    privateError(response);
  });

  it.each(["{not-json", "null", "[]", '"text"', "123"])("rejects invalid JSON object body %s", async (body) => {
    const response = await POST(request(body, true));
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ success: false, error: { code: "OTP_REQUEST_INVALID", message: "Invalid OTP completion request." } });
    expect(completeOtpChallenge).not.toHaveBeenCalled();
    privateError(response);
  });

  it.each([
    ["challengeToken", undefined], ["challengeToken", {}], ["challengeToken", ""], ["challengeToken", "x".repeat(44)], ["challengeToken", "!".repeat(43)],
    ["purpose", undefined], ["purpose", "other"], ["purpose", {}],
    ["code", null], ["code", {}], ["code", []], ["code", true], ["code", 123456], ["code", "123"], ["code", "1".repeat(11)], ["code", "abcd"], ["code", " "],
    ["recoveryReceipt", null], ["recoveryReceipt", {}], ["recoveryReceipt", ""], ["recoveryReceipt", " "], ["recoveryReceipt", "r".repeat(2049)],
  ])("rejects invalid bounded %s field %j before service invocation", async (field, value) => {
    const response = await POST(request({ ...valid, [field]: value }));
    expect(response.status).toBe(400);
    expect(completeOtpChallenge).not.toHaveBeenCalled();
    privateError(response);
  });

  it.each([
    ["OTP_PURPOSE_MISMATCH", 400, "OTP purpose mismatch."],
    ["OTP_RECOVERY_INVALID", 400, "Invalid verification recovery receipt."],
    ["OTP_VERIFICATION_REQUIRED", 401, "OTP verification is required."],
    ["OTP_VERIFICATION_INVALID", 401, "OTP verification is invalid."],
    ["OTP_VERIFICATION_EXPIRED", 401, "OTP verification has expired."],
    ["OTP_VERIFICATION_ALREADY_USED", 401, "OTP verification was already used."],
    ["INVALID_OTP", 401, "Invalid verification code."],
    ["OTP_COMPLETION_IN_PROGRESS", 409, "OTP completion is in progress."],
    ["OTP_VERIFY_TEMPORARY_FAILURE", 503, "OTP verification is temporarily unavailable."],
    ["OTP_SERVICE_NOT_CONFIGURED", 503, "OTP verification is unavailable."],
    ["OTP_PERSISTENCE_FAILED", 503, "OTP state could not be saved or read."],
  ])("maps trusted %s without exposing service details", async (code, status, message) => {
    completeOtpChallenge.mockRejectedValue(Object.assign(new OtpError(code, status, "private-secret"), { verificationSid: "private-sid" }));
    const response = await POST(request());
    expect(response.status).toBe(status);
    expect(await response.json()).toEqual({ success: false, error: { code, message } });
    privateError(response);
  });

  it("returns recovery receipt at the top level with filtered retry metadata", async () => {
    completeOtpChallenge.mockRejectedValue(Object.assign(new OtpError("OTP_PERSISTENCE_FAILED", 503, "private", 600, timing), { recoveryReceipt: "opaque-recovery", codeValue: "private-code" }));
    const response = await POST(request());
    expect(await response.json()).toEqual({ success: false, error: { code: "OTP_PERSISTENCE_FAILED", message: "OTP state could not be saved or read." }, recoveryReceipt: "opaque-recovery", ...timing });
    expect(response.headers.get("retry-after")).toBeNull();
    privateError(response);
  });

  it.each(["OTP_VERIFY_RATE_LIMITED", "OTP_SEND_BUDGET_EXCEEDED"])("preserves Retry-After for trusted %s", async (code) => {
    const metadata = code === "OTP_SEND_BUDGET_EXCEEDED" ? { ...timing, restrictionScope: "global", retryAfterSeconds: 86400, retryAt: "2026-08-24T12:00:00.000Z" } : timing;
    completeOtpChallenge.mockRejectedValue(new OtpError(code, 429, "private", metadata.retryAfterSeconds, metadata));
    const response = await POST(request());
    expect(response.status).toBe(429);
    expect(response.headers.get("retry-after")).toBe(String(metadata.retryAfterSeconds));
    expect(await response.json()).toMatchObject(metadata);
    privateError(response);
  });

  it.each([null, {}, "", " ", "r".repeat(2049)])("strips invalid trusted error receipts %j", async (recoveryReceipt) => {
    completeOtpChallenge.mockRejectedValue(Object.assign(new OtpError("OTP_PERSISTENCE_FAILED", 503, "private"), { recoveryReceipt }));
    const response = await POST(request());
    expect(await response.json()).not.toHaveProperty("recoveryReceipt");
    privateError(response);
  });

  it.each(["OTP_VERIFY_RATE_LIMITED", "toString", "__proto__"])("does not trust raw error %s or its recovery receipt", async (code) => {
    const logger = vi.spyOn(console, "error").mockImplementation(() => {});
    completeOtpChallenge.mockRejectedValue(Object.assign(new Error("private-secret"), { code, status: 429, recoveryReceipt: "private-receipt", ...timing }));
    const response = await POST(request());
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ success: false, error: { code: "OTP_COMPLETION_FAILED", message: "OTP completion failed." } });
    expect(response.headers.get("retry-after")).toBeNull();
    expect(logger).not.toHaveBeenCalled();
    privateError(response);
  });
});

describe("POST /api/customer/logout", () => {
  it("expires only the customer session cookie", async () => {
    const response = await logoutCustomer();
    expect(await response.json()).toEqual({ success: true });
    expect(response.cookies.getAll()).toHaveLength(1);
    expect(response.cookies.get("customer_session")).toMatchObject({ value: "", maxAge: 0, path: "/" });
  });
});
