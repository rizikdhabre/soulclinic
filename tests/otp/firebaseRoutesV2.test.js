import { beforeEach, describe, expect, it, vi } from "vitest";
import { OtpError } from "@/lib/otp/errors";
const services = vi.hoisted(() => ({ requestFirebaseSend: vi.fn(), requestFirebaseFallback: vi.fn(), completeOtpChallenge: vi.fn() }));
vi.mock("@/lib/otp/firebaseSend", () => services);
vi.mock("@/lib/otp/completionService", () => services);
import { POST as send } from "@/app/api/otp/firebase-send/route";
import { POST as fallback } from "@/app/api/otp/fallback/route";
import { POST as complete } from "@/app/api/otp/complete/route";
const token = "a".repeat(43);
const firebaseSendId = "061a1297-e394-40a2-9e22-fc63b2c186a1";
const report = { code: "auth/internal-error", stage: "send", provenance: "firebase_sdk" };
const request = (body) => new Request("https://preview.example/api/otp/fallback", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

describe("Firebase endpoint boundaries", () => {
  beforeEach(() => { Object.values(services).forEach((mock) => mock.mockReset()); });
  it("projects a settled server-verification fallback permit only for the trusted temporary failure", async () => {
    for (const code of ["OTP_VERIFY_TEMPORARY_FAILURE", "OTP_PERSISTENCE_FAILED", "OTP_VERIFICATION_INVALID"]) {
      services.completeOtpChallenge.mockRejectedValue(Object.assign(new OtpError(code, 503, "private"), { firebaseFallbackAllowed: true }));
      const response = await complete(request({ challengeToken: token, purpose: "login", idToken: "test-only-proof" }));
      const body = await response.json();
      expect(body.firebaseFallbackAllowed === true).toBe(code === "OTP_VERIFY_TEMPORARY_FAILURE");
      expect(JSON.stringify(body)).not.toContain("private");
      expect(response.cookies.getAll()).toEqual([]);
    }
  });
  it("forwards validated diagnostic SDK codes separately from the failure report", async () => {
    services.requestFirebaseSend.mockResolvedValue({ status: "failed" });
    const failure = { code: "client/unclassified", stage: "send", provenance: "firebase_sdk" };
    const req = request({ challengeToken: token, firebaseSendId, operation: "rejected", failure,
      diagnostic: { sdkErrorCode: "auth/invalid-credential", token: "private-token", message: "private-token" } });
    expect((await send(req)).status).toBe(200);
    expect(services.requestFirebaseSend).toHaveBeenCalledExactlyOnceWith({ request: req, challengeToken: token,
      firebaseSendId, operation: "rejected", failure, diagnostic: { sdkErrorCode: "auth/invalid-credential" } });
  });
  it("projects diagnostic enums only and never forwards phone, tokens or arbitrary exception content", async () => {
    services.requestFirebaseSend.mockResolvedValue({ recorded: true });
    const req = request({ challengeToken: token, firebaseSendId, operation: "diagnostic", failure: report,
      diagnostic: { boundary: "firebase_sdk_load", errorType: "TypeError", message: "private", stack: "private", idToken: "private" } });
    const response = await send(req);
    expect(response.status).toBe(200);
    expect(services.requestFirebaseSend).toHaveBeenCalledExactlyOnceWith({ request: req, challengeToken: token, firebaseSendId, operation: "diagnostic", failure: report,
      diagnostic: { boundary: "firebase_sdk_load", errorType: "TypeError" } });
    expect(await response.json()).toEqual({ recorded: true });
  });
  it("allows only server-owned fields into send reservation", async () => {
    services.requestFirebaseSend.mockResolvedValue({ provider: "firebase", status: "reserved", firebaseSendId, phone: "+972500000001" });
    const req = request({ challengeToken: token, operation: "reserve", provider: "twilio", phone: "untrusted", purpose: "untrusted", success: true });
    const response = await send(req);
    expect(response.status).toBe(200);
    expect(services.requestFirebaseSend).toHaveBeenCalledExactlyOnceWith({ request: req, challengeToken: token, operation: "reserve", firebaseSendId: undefined, failure: undefined });
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.cookies.getAll()).toEqual([]);
  });
  it("projects only the bounded fallback report and opaque send receipt", async () => {
    services.requestFirebaseFallback.mockResolvedValue({ provider: "twilio", status: "pending" });
    const req = request({ challengeToken: token, firebaseSendId, failure: { ...report, rawPhone: "private", token: "private" }, recoveryReceipt: "opaque", success: true });
    const response = await fallback(req);
    expect(response.status).toBe(200);
    expect(services.requestFirebaseFallback).toHaveBeenCalledExactlyOnceWith({ request: req, challengeToken: token, firebaseSendId, failure: report, recoveryReceipt: "opaque" });
    expect(await response.json()).toEqual({ provider: "twilio", status: "pending" });
  });
  it.each([null, [], { challengeToken: {} }, { challengeToken: token, firebaseSendId: "x".repeat(37) }, { challengeToken: token, recoveryReceipt: "x".repeat(2049) }])("rejects malformed request %j", async (body) => {
    expect((await fallback(request(body))).status).toBe(400);
    expect(services.requestFirebaseFallback).not.toHaveBeenCalled();
  });
  it("returns scope and retry metadata without provider payloads", async () => {
    services.requestFirebaseFallback.mockRejectedValue(Object.assign(new OtpError("OTP_SEND_SOURCE_RATE_LIMITED", 429, "private provider content"), {
      retryAt: "2026-09-11T10:10:00.000Z", serverTime: "2026-09-11T10:00:00.000Z", retryAfterSeconds: 600, restrictionScope: "source", rawPhone: "private-phone", token: "private-token",
    }));
    const response = await fallback(request({ challengeToken: token, firebaseSendId, failure: report }));
    expect(response.status).toBe(429);
    expect(response.headers.get("retry-after")).toBe("600");
    const body = await response.json();
    expect(body).toMatchObject({ error: "OTP_SEND_SOURCE_RATE_LIMITED", restrictionScope: "source", retryAfterSeconds: 600 });
    expect(JSON.stringify(body)).not.toContain("private");
  });
  it("forwards actual Firebase proof, never client success or phone assertions", async () => {
    services.completeOtpChallenge.mockResolvedValue({ purpose: "booking", success: true, verificationToken: "b".repeat(43), expiresInSeconds: 600, profile: { hasCompleteName: false } });
    const proof = "mock-id-token-only-for-test";
    const response = await complete(request({ challengeToken: token, purpose: "booking", idToken: proof, success: true, phone: "forged", provider: "firebase" }));
    expect(response.status).toBe(200);
    expect(services.completeOtpChallenge).toHaveBeenCalledExactlyOnceWith({ challengeToken: token, purpose: "booking", idToken: proof, code: undefined });
    expect(JSON.stringify(await response.json())).not.toContain(proof);
  });
  it.each([null, {}, "", "x".repeat(16385)])("rejects malformed proof %j", async (idToken) => {
    expect((await complete(request({ challengeToken: token, purpose: "login", idToken }))).status).toBe(400);
    expect(services.completeOtpChallenge).not.toHaveBeenCalled();
  });
  it("preserves Admin infrastructure failure as 503 instead of invalid OTP", async () => {
    services.completeOtpChallenge.mockRejectedValue(new OtpError("OTP_VERIFY_TEMPORARY_FAILURE", 503, "private network payload"));
    const response = await complete(request({ challengeToken: token, purpose: "login", idToken: "test-only-proof" }));
    expect(response.status).toBe(503);
    expect((await response.json()).error.code).toBe("OTP_VERIFY_TEMPORARY_FAILURE");
    expect(response.cookies.getAll()).toEqual([]);
  });
});
