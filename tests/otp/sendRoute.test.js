import { beforeEach, describe, expect, it, vi } from "vitest";
import { OtpError } from "@/lib/otp/errors";

const { requestTwilioSend } = vi.hoisted(() => ({ requestTwilioSend: vi.fn() }));
vi.mock("@/lib/otp/twilioSend", () => ({ requestTwilioSend }));
import { POST } from "@/app/api/otp/send/route";

const token = "a".repeat(43);
const valid = { challengeToken: token };
const timing = {
  retryAt: "2026-08-24T12:00:00.000Z", serverTime: "2026-08-23T12:00:00.000Z",
  phoneRetryAt: "2026-08-23T12:01:00.000Z", restrictionScope: "global", retryAfterSeconds: 86400,
  correlationId: "061a1297-e394-40a2-9e22-fc63b2c186a1",
};
function request(body = valid, raw = false) {
  return new Request("https://example.com/api/otp/send", {
    method: "POST", headers: { "content-type": "application/json" }, body: raw ? body : JSON.stringify(body),
  });
}
function privateResponse(response) {
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect(response.cookies.getAll()).toEqual([]);
}

describe("POST /api/otp/send", () => {
  beforeEach(() => {
    requestTwilioSend.mockReset();
    requestTwilioSend.mockResolvedValue({ provider: "twilio", status: "pending", sid: "private-sid", phone: "private-phone", delivered: true, body: "private-body", recoveryReceipt: "private-receipt", restartAllowed: true });
  });

  it.each([undefined, "opaque-recovery", "r".repeat(2048)])("forwards only request, token and optional receipt %j", async (recoveryReceipt) => {
    const payload = { ...valid, ...(recoveryReceipt === undefined ? {} : { recoveryReceipt }) };
    const input = request({ ...payload, phone: "untrusted", sourceHash: "untrusted", sid: "untrusted", provider: "untrusted", restartAllowed: true });
    const response = await POST(input);
    expect(requestTwilioSend).toHaveBeenCalledExactlyOnceWith({ ...payload, request: input });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ provider: "twilio", status: "pending" });
    privateResponse(response);
  });

  it.each([
    undefined, null, {}, { provider: "twilio" }, { status: "pending" },
    { provider: "other", status: "pending" }, { provider: "twilio", status: "approved" },
    { provider: "twilio", status: "delivered" }, { provider: "twilio", status: "delivery_unknown", recoveryReceipt: "private-receipt", restartAllowed: true },
  ])("does not turn an unexpected service result %j into successful send acceptance", async (result) => {
    requestTwilioSend.mockResolvedValue(result);
    const response = await POST(request());
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({
      error: "OTP_SEND_PENDING", message: "The verification request may still be processing. Please wait before trying again.",
    });
    privateResponse(response);
  });

  it.each(["{not-json", "null", "[]", '"text"', "123"])("rejects invalid JSON object body %s", async (body) => {
    const response = await POST(request(body, true));
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "OTP_SEND_FAILED", message: "Failed to request OTP send." });
    expect(requestTwilioSend).not.toHaveBeenCalled();
    privateResponse(response);
  });

  it.each([
    ["challengeToken", undefined], ["challengeToken", null], ["challengeToken", {}], ["challengeToken", ""],
    ["challengeToken", "x".repeat(44)], ["challengeToken", "!".repeat(43)],
    ["recoveryReceipt", null], ["recoveryReceipt", {}], ["recoveryReceipt", ""], ["recoveryReceipt", " "], ["recoveryReceipt", "r".repeat(2049)],
  ])("rejects invalid bounded %s field %j", async (field, value) => {
    const response = await POST(request({ ...valid, [field]: value }));
    expect(response.status).toBe(400);
    expect(requestTwilioSend).not.toHaveBeenCalled();
    privateResponse(response);
  });

  it.each([
    ["OTP_CHALLENGE_FAILED", 400, "Invalid or expired OTP challenge."],
    ["OTP_CHALLENGE_EXPIRED", 400, "OTP challenge has expired."],
    ["OTP_RECOVERY_INVALID", 400, "Invalid verification recovery receipt."],
    ["OTP_SERVICE_NOT_CONFIGURED", 503, "OTP service is not configured."],
    ["OTP_SEND_PENDING", 503, "The verification request may still be processing. Please wait before trying again."],
    ["OTP_SEND_FAILED", 503, "Failed to request OTP send."],
    ["OTP_PERSISTENCE_FAILED", 503, "OTP state could not be saved or read."],
    ["OTP_STATE_BUSY", 503, "OTP security state is busy."],
  ])("maps trusted %s to a clean error", async (code, status, message) => {
    requestTwilioSend.mockRejectedValue(Object.assign(new OtpError(code, status, "private-provider"), { sid: "private-sid" }));
    const response = await POST(request());
    expect(response.status).toBe(status);
    expect(await response.json()).toEqual({ error: code, message });
    privateResponse(response);
  });

  it.each([
    ["OTP_RATE_LIMITED", "phone", 60], ["OTP_SEND_SOURCE_RATE_LIMITED", "source", 600], ["OTP_SEND_BUDGET_EXCEEDED", "global", 86400],
  ])("preserves %s Retry-After and all bounded metadata", async (code, restrictionScope, retryAfterSeconds) => {
    const metadata = { ...timing, restrictionScope, retryAfterSeconds };
    requestTwilioSend.mockRejectedValue(new OtpError(code, 429, "private", retryAfterSeconds, metadata));
    const response = await POST(request());
    expect(response.status).toBe(429);
    expect(response.headers.get("retry-after")).toBe(String(retryAfterSeconds));
    expect(await response.json()).toMatchObject({ error: code, ...metadata });
    privateResponse(response);
  });

  it("returns a trusted receipt at the top level without provider result fields", async () => {
    requestTwilioSend.mockRejectedValue(Object.assign(new OtpError("OTP_PERSISTENCE_FAILED", 503, "private", 86400, timing), { recoveryReceipt: "opaque-recovery", sid: "private-sid", phone: "private-phone" }));
    const response = await POST(request());
    expect(await response.json()).toEqual({ error: "OTP_PERSISTENCE_FAILED", message: "OTP state could not be saved or read.", recoveryReceipt: "opaque-recovery", ...timing });
    expect(response.headers.get("retry-after")).toBeNull();
    privateResponse(response);
  });

  it.each([null, {}, "", " ", "r".repeat(2049)])("strips invalid trusted error receipts %j", async (recoveryReceipt) => {
    requestTwilioSend.mockRejectedValue(Object.assign(new OtpError("OTP_PERSISTENCE_FAILED", 503, "private"), { recoveryReceipt }));
    const response = await POST(request());
    expect(await response.json()).not.toHaveProperty("recoveryReceipt");
    privateResponse(response);
  });

  it.each(["OTP_SEND_FAILED", "OTP_CHALLENGE_EXPIRED"])("returns a trusted explicit restart decision for %s", async (code) => {
    requestTwilioSend.mockRejectedValue(Object.assign(new OtpError(code, 503, "private"), { restartAllowed: true }));
    const response = await POST(request());
    expect(await response.json()).toMatchObject({ error: code, restartAllowed: true });
    privateResponse(response);
  });

  it.each([undefined, false, "true", 1, {}])("does not infer a restart from flag %j or terminal error code", async (restartAllowed) => {
    requestTwilioSend.mockRejectedValue(Object.assign(new OtpError("OTP_SEND_FAILED", 503, "private"), { restartAllowed }));
    const response = await POST(request());
    expect(await response.json()).not.toHaveProperty("restartAllowed");
  });

  it.each(["OTP_SEND_PENDING", "OTP_PERSISTENCE_FAILED"])("does not invite a new challenge after %s", async (code) => {
    requestTwilioSend.mockRejectedValue(new OtpError(code, 503, "private"));
    expect(await (await POST(request())).json()).not.toHaveProperty("restartAllowed");
  });

  it.each(["OTP_SEND_BUDGET_EXCEEDED", "toString", "__proto__"])("ignores untrusted error %s and all control metadata", async (code) => {
    const logger = vi.spyOn(console, "error").mockImplementation(() => {});
    requestTwilioSend.mockRejectedValue(Object.assign(new Error("private-secret"), { code, status: 429, recoveryReceipt: "private-receipt", restartAllowed: true, ...timing }));
    const response = await POST(request());
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: "OTP_SEND_FAILED", message: "Failed to request OTP send." });
    expect(response.headers.get("retry-after")).toBeNull();
    expect(logger).not.toHaveBeenCalled();
    privateResponse(response);
  });

  it("strips unsafe timing from trusted rate errors", async () => {
    requestTwilioSend.mockRejectedValue(Object.assign(new OtpError("OTP_SEND_BUDGET_EXCEEDED", 429, "private"), { retryAfterSeconds: Infinity, retryAt: "private-token", serverTime: "private-body", correlationId: "private-id", restrictionScope: "private-scope" }));
    const response = await POST(request());
    expect(await response.json()).toEqual({ error: "OTP_SEND_BUDGET_EXCEEDED", message: "OTP send budget exceeded." });
    expect(response.headers.get("retry-after")).toBeNull();
    privateResponse(response);
  });
});
