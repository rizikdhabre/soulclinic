import { describe, expect, it, vi } from "vitest";
import { logOtpEvent } from "@/lib/otp/diagnostics";

const correlationId = "061a1297-e394-40a2-9e22-fc63b2c186a1";

describe("privacy-safe OTP diagnostics", () => {
  it("logs only the explicit bounded cross-client/server contract", () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    const safe = {
      correlationId, stage: "fallback", provider: "twilio",
      errorCode: "OTP_FALLBACK_SOURCE_RATE_LIMITED", decision: "blocked",
      restrictionScope: "source", retryAt: "2026-08-23T12:10:00.000Z", retryAfterSeconds: 600,
    };
    logOtpEvent({ ...safe, phone: "+972521234567", ip: "192.0.2.1", token: "secret", message: "secret", payload: { otp: "654321" } });
    expect(info).toHaveBeenCalledWith("OTP flow", safe);
  });

  it.each(["firebase", "firebase_send", "fallback", "complete", "challenge", "twilio"])("supports the %s stage", (stage) => {
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    logOtpEvent({ correlationId, stage, provider: "firebase", decision: "succeeded", errorCode: "auth/network-request-failed" });
    expect(info).toHaveBeenCalledWith("OTP flow", { correlationId, stage, provider: "firebase", decision: "succeeded", errorCode: "auth/network-request-failed" });
  });

  it.each(["reject", "fallback", "failed", "success"])("supports the client %s decision", (decision) => {
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    logOtpEvent({ stage: "firebase_send", decision });
    expect(info).toHaveBeenCalledWith("OTP flow", { stage: "firebase_send", decision });
  });

  it.each(["OTP_FLOW_CANCELLED", "otp/recaptcha-setup-failed"])("records the fixed client outcome %s", (errorCode) => {
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    logOtpEvent({ stage: "firebase_send", errorCode });
    expect(info).toHaveBeenCalledWith("OTP flow", { stage: "firebase_send", errorCode });
  });

  it.each(["+972521234567", "192.0.2.1", "token-secret", "OTP_SECRET", "auth/private-token", { message: "private" }, ["firebase"]])(
    "drops untrusted values even in whitelisted fields: %j", (value) => {
      const info = vi.spyOn(console, "info").mockImplementation(() => {});
      logOtpEvent({ correlationId: value, stage: value, provider: value, errorCode: value, decision: value, restrictionScope: value, retryAt: value, retryAfterSeconds: value });
      expect(info).not.toHaveBeenCalled();
    },
  );

  it.each([NaN, Infinity, -1, 0, 1.2, 3601, "60"])("drops invalid retry seconds %j", (retryAfterSeconds) => {
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    logOtpEvent({ stage: "challenge", retryAfterSeconds, retryAt: "2026-99-99T99:99:99.000Z" });
    expect(info).toHaveBeenCalledWith("OTP flow", { stage: "challenge" });
  });

  it("cannot interrupt the OTP flow when the logging sink fails", () => {
    vi.spyOn(console, "info").mockImplementation(() => { throw new Error("sink unavailable"); });
    expect(() => logOtpEvent({ stage: "challenge", decision: "started" })).not.toThrow();
  });
});
