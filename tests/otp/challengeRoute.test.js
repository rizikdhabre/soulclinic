import { beforeEach, describe, expect, it, vi } from "vitest";
import { OtpError } from "@/lib/otp/errors";

const { createOtpChallenge } = vi.hoisted(() => ({ createOtpChallenge: vi.fn() }));
vi.mock("@/lib/otp/challengeService", () => ({ createOtpChallenge }));
import { POST } from "@/app/api/otp/challenge/route";

const token = "a".repeat(43);
const valid = { phone: "0521234567", purpose: "booking" };
const timing = {
  retryAt: "2026-08-23T12:01:00.000Z", serverTime: "2026-08-23T12:00:09.000Z",
  restrictionScope: "phone", correlationId: "061a1297-e394-40a2-9e22-fc63b2c186a1", retryAfterSeconds: 51,
};
function request(body = valid, raw = false) {
  return new Request("https://example.com/api/otp/challenge", {
    method: "POST", headers: { "content-type": "application/json" }, body: raw ? body : JSON.stringify(body),
  });
}
function privateResponse(response) {
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect(response.cookies.getAll()).toEqual([]);
}

describe("POST /api/otp/challenge", () => {
  beforeEach(() => {
    createOtpChallenge.mockReset();
    createOtpChallenge.mockResolvedValue({
      challengeToken: token, provider: "twilio", expiresAt: new Date("2026-08-23T12:10:00.000Z"),
      ...timing, phone: "private-phone", sourceHash: "private-source", verificationSid: "private-sid",
      recoveryReceipt: "private-receipt", profile: { firstName: "private-name" },
    });
  });

  it.each(["booking", "login"])("forwards the request and %s purpose while minimizing success", async (purpose) => {
    const input = request({ ...valid, purpose, provider: "untrusted", sourceHash: "untrusted", exists: true });
    const response = await POST(input);
    expect(createOtpChallenge).toHaveBeenCalledExactlyOnceWith({ request: input, phone: valid.phone, purpose });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ challengeToken: token, provider: "twilio", expiresAt: "2026-08-23T12:10:00.000Z", ...timing });
    privateResponse(response);
  });

  it.each(["{not-json", "null", "[]", '"text"', "123", "true"])("rejects invalid JSON object body %s", async (body) => {
    const response = await POST(request(body, true));
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "OTP_CHALLENGE_FAILED", message: "Failed to create OTP challenge." });
    expect(createOtpChallenge).not.toHaveBeenCalled();
    privateResponse(response);
  });

  it.each([undefined, null, {}, [], 521234567, "", " ", "1".repeat(33)])("rejects invalid phone field %j", async (phone) => {
    const response = await POST(request({ ...valid, phone }));
    expect(response.status).toBe(400);
    expect((await response.json()).error).toBe("INVALID_PHONE");
    expect(createOtpChallenge).not.toHaveBeenCalled();
    privateResponse(response);
  });

  it.each([undefined, null, {}, "", "unknown", "LOGIN", "login "])("rejects invalid purpose %j", async (purpose) => {
    const response = await POST(request({ ...valid, purpose }));
    expect(response.status).toBe(400);
    expect((await response.json()).error).toBe("INVALID_OTP_PURPOSE");
    expect(createOtpChallenge).not.toHaveBeenCalled();
    privateResponse(response);
  });

  it.each([
    ["INVALID_PHONE", 400, "Invalid phone number."],
    ["INVALID_OTP_PURPOSE", 400, "Invalid OTP purpose."],
    ["OTP_SERVICE_NOT_CONFIGURED", 503, "OTP service is not configured."],
    ["OTP_SOURCE_UNAVAILABLE", 503, "OTP source identity is unavailable."],
    ["OTP_PERSISTENCE_FAILED", 503, "OTP state could not be saved or read."],
    ["OTP_STATE_BUSY", 503, "OTP security state is busy."],
  ])("returns sanitized trusted %s errors", async (code, status, message) => {
    createOtpChallenge.mockRejectedValue(new OtpError(code, status, "private configuration detail"));
    const response = await POST(request());
    expect(response.status).toBe(status);
    expect(await response.json()).toEqual({ error: code, message });
    privateResponse(response);
  });

  it.each(["OTP_RATE_LIMITED", "OTP_SOURCE_RATE_LIMITED"])("sets Retry-After and safe timing on %s", async (code) => {
    createOtpChallenge.mockRejectedValue(new OtpError(code, 429, "private", 51, timing));
    const response = await POST(request());
    expect(response.status).toBe(429);
    expect(response.headers.get("retry-after")).toBe("51");
    expect(await response.json()).toMatchObject({ error: code, ...timing });
    privateResponse(response);
  });

  it("strips invalid metadata without setting Retry-After", async () => {
    createOtpChallenge.mockRejectedValue(Object.assign(new OtpError("OTP_RATE_LIMITED", 429, "private"), {
      retryAfterSeconds: 86401, retryAt: "private-token", serverTime: "private-body", phoneRetryAt: "private-phone",
      correlationId: "private-id", restrictionScope: "private-source", recoveryReceipt: "x".repeat(2049),
    }));
    const response = await POST(request());
    expect(await response.json()).toEqual({ error: "OTP_RATE_LIMITED", message: "OTP request rate limit exceeded." });
    expect(response.headers.get("retry-after")).toBeNull();
    privateResponse(response);
  });

  it("returns a bounded receipt only for a trusted error", async () => {
    createOtpChallenge.mockRejectedValue(Object.assign(new OtpError("OTP_PERSISTENCE_FAILED", 503, "private"), { recoveryReceipt: "opaque-recovery", ...timing }));
    const response = await POST(request());
    expect(await response.json()).toEqual({ error: "OTP_PERSISTENCE_FAILED", message: "OTP state could not be saved or read.", recoveryReceipt: "opaque-recovery", ...timing });
    expect(response.headers.get("retry-after")).toBeNull();
    privateResponse(response);
  });

  it.each(["OTP_RATE_LIMITED", "toString", "__proto__"])("does not trust a raw error carrying %s and receipt metadata", async (code) => {
    const logger = vi.spyOn(console, "error").mockImplementation(() => {});
    createOtpChallenge.mockRejectedValue(Object.assign(new Error("private-secret"), { code, status: 429, recoveryReceipt: "private-receipt", ...timing }));
    const response = await POST(request());
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: "OTP_CHALLENGE_FAILED", message: "Failed to create OTP challenge." });
    expect(response.headers.get("retry-after")).toBeNull();
    expect(logger).not.toHaveBeenCalled();
    privateResponse(response);
  });
});
