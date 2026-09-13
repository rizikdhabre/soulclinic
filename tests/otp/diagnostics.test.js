import { beforeEach, describe, expect, it, vi } from "vitest";
import { isOtpCorrelationId, isOtpIsoTime, logOtpEvent, logFirebaseAdminEvent } from "@/lib/otp/diagnostics";
import { sealOtpReceipt } from "@/lib/otp/recovery";
import { FIREBASE_FAILURE_CODES } from "@/lib/otp/firebaseSendPolicy";

const correlationId = "061a1297-e394-40a2-9e22-fc63b2c186a1";

describe("privacy-safe OTP diagnostics", () => {
  let info;
  beforeEach(() => {
    info = vi.spyOn(console, "info").mockImplementation(() => {});
  });

  it.each(FIREBASE_FAILURE_CODES)("retains the classified client failure %s instead of an empty error", (errorCode) => {
    logOtpEvent({ correlationId, stage: "firebase_send_rejected", errorCode });
    expect(info).toHaveBeenCalledExactlyOnceWith("OTP flow", { correlationId, stage: "firebase_send_rejected", errorCode });
  });

  it("retains bounded failure context and fallback decision without raw error data", () => {
    const safe = { correlationId, stage: "firebase_send_rejected", errorCode: "client/unclassified",
      failureStage: "initialize", failureProvenance: "client", failureCategory: "unclassified",
      failureBoundary: "firebase_sdk_load", errorType: "TypeError", fallbackDecision: "blocked", fallbackReason: "not_eligible" };
    logOtpEvent({ ...safe, message: "private", stack: "private", phone: "private", diagnostic: { token: "private" } });
    expect(info).toHaveBeenCalledExactlyOnceWith("OTP flow", safe);
    info.mockClear();
    logOtpEvent({ stage: "firebase_send_rejected", failureStage: "private", failureProvenance: "private", failureCategory: "private",
      failureBoundary: "private", errorType: "private", fallbackDecision: "private", fallbackReason: "private" });
    expect(info).toHaveBeenCalledExactlyOnceWith("OTP flow", { stage: "firebase_send_rejected" });
  });

  it.each([
    [Object.assign(new Error("private-phone-token-key"), { code: "private-phone-token-key" }), "admin/unclassified"],
    [new TypeError("private-phone-token-key"), "admin/type-error"],
    [Object.assign(new Error("private-phone-token-key"), { code: "app/invalid-credential" }), "app/invalid-credential"],
  ])("bounds Admin diagnostics without propagating raw errors (%#)", (error, errorCode) => {
    logFirebaseAdminEvent({ correlationId, stage: "firebase_admin_verify", decision: "failed", error });
    expect(info).toHaveBeenCalledExactlyOnceWith("OTP flow", { correlationId, stage: "firebase_admin_verify", decision: "failed", provider: "firebase", errorCode });
    expect(JSON.stringify(info.mock.calls)).not.toContain("private-phone-token-key");
  });

  it("does not create uncorrelated Admin events or let a failed sink change verification", () => {
    logFirebaseAdminEvent({ correlationId: "private-phone", stage: "firebase_admin_verify", decision: "failed", error: new Error("private") });
    expect(info).not.toHaveBeenCalled();
    info.mockImplementation(() => { throw new Error("offline logging"); });
    expect(() => logFirebaseAdminEvent({ correlationId, stage: "firebase_admin_init", decision: "failed", error: new Error("private") })).not.toThrow();
  });

  it("logs bounded fallback reasons, deployment metadata and elapsed time without payloads", () => {
    const safe = { correlationId, stage: "fallback_decision", provider: "firebase", decision: "reserved", reason: "sdk_send_rejected_ambiguous", environment: "preview", deploymentSha: "a".repeat(40), elapsedMs: 1200 };
    logOtpEvent({ ...safe, idToken: "private", captchaToken: "private", error: { rawPayload: "private" } });
    expect(info).toHaveBeenCalledExactlyOnceWith("OTP flow", safe);
  });

  it("drops unbounded reasons and deployment fields", () => {
    logOtpEvent({ stage: "firebase_send_rejected", reason: "private-phone", environment: "private-env", deploymentSha: "private-sha", elapsedMs: Infinity });
    expect(info).toHaveBeenCalledExactlyOnceWith("OTP flow", { stage: "firebase_send_rejected" });
  });

  it("logs only the explicit bounded contract, never identity, provider payloads or encrypted receipts", () => {
    const recoveryReceipt = sealOtpReceipt({ phone: "+972521234567", operation: "verify", purpose: "booking" }, {
      CUSTOMER_SESSION_SECRET: "s".repeat(48),
    });
    const safe = {
      correlationId, stage: "send", provider: "twilio", errorCode: "OTP_SEND_SOURCE_RATE_LIMITED", decision: "blocked",
      restrictionScope: "source", retryAt: "2026-08-23T12:10:00.000Z", retryAfterSeconds: 600,
    };
    logOtpEvent({
      ...safe, phone: "+972521234567", ip: "192.0.2.1", sourceHash: "private-source-hash",
      token: "secret", challengeToken: "private-challenge-token", verificationToken: "private-grant",
      sessionToken: "private-session", verificationSid: `VE${"a".repeat(32)}`, recoveryReceipt,
      code: "654321", message: "private-error", error: new Error("private-error"), payload: { otp: "654321" },
    });
    expect(info).toHaveBeenCalledExactlyOnceWith("OTP flow", safe);
    expect(JSON.stringify(info.mock.calls)).not.toContain(recoveryReceipt);
  });

  it.each(["challenge", "send", "verify", "complete", "configuration"])("supports the %s stage", (stage) => {
    logOtpEvent({ correlationId, stage, provider: "twilio", decision: "success" });
    expect(info).toHaveBeenCalledExactlyOnceWith("OTP flow", { correlationId, stage, provider: "twilio", decision: "success" });
  });

  it.each(["started", "reserved", "success", "failed", "blocked", "reject", "recovered"])("supports decision %s", (decision) => {
    logOtpEvent({ stage: "verify", decision });
    expect(info).toHaveBeenCalledExactlyOnceWith("OTP flow", { stage: "verify", decision });
  });

  it.each(["OTP_FLOW_CANCELLED", "OTP_RECOVERY_INVALID", "OTP_PURPOSE_MISMATCH", "OTP_SERVICE_NOT_CONFIGURED", "OTP_SEND_BUDGET_EXCEEDED", "OTP_VERIFY_TEMPORARY_FAILURE", "OTP_RATE_LIMIT_CONFIG_INVALID"])(
    "records bounded outcome %s", (errorCode) => {
      logOtpEvent({ stage: "complete", errorCode });
      expect(info).toHaveBeenCalledExactlyOnceWith("OTP flow", { stage: "complete", errorCode });
    },
  );

  it.each(["+972521234567", "192.0.2.1", "private-token", "OTP_SECRET", "A".repeat(512), { message: "private" }, ["twilio"], null])(
    "drops untrusted values even in allowed fields: %j", (value) => {
      logOtpEvent({ correlationId: value, stage: value, provider: value, errorCode: value, decision: value, restrictionScope: value, retryAt: value, retryAfterSeconds: value });
      expect(info).not.toHaveBeenCalled();
    },
  );

  it.each([NaN, Infinity, -1, 0, 1.2, 86401, "60"])("drops invalid retry seconds %j", (retryAfterSeconds) => {
    logOtpEvent({ stage: "challenge", retryAfterSeconds, retryAt: "2026-99-99T99:99:99.000Z" });
    expect(info).toHaveBeenCalledExactlyOnceWith("OTP flow", { stage: "challenge" });
  });

  it.each([1, 3601, 86400])("retains valid bounded retry seconds %s", (retryAfterSeconds) => {
    logOtpEvent({ stage: "send", retryAfterSeconds });
    expect(info).toHaveBeenCalledExactlyOnceWith("OTP flow", { stage: "send", retryAfterSeconds });
  });

  it.each(["phone", "source", "global"])("retains restriction scope %s without an identifier", (restrictionScope) => {
    logOtpEvent({ restrictionScope, phone: "private-phone", sourceHash: "private-source" });
    expect(info).toHaveBeenCalledExactlyOnceWith("OTP flow", { restrictionScope });
  });

  it("drops unknown enums without suppressing valid event fields", () => {
    logOtpEvent({ correlationId, stage: "private-stage", decision: "private-result", errorCode: "private-error", restrictionScope: "private-source" });
    expect(info).toHaveBeenCalledExactlyOnceWith("OTP flow", { correlationId });
  });

  it("does not emit empty events", () => {
    logOtpEvent();
    logOtpEvent({ recoveryReceipt: "opaque-receipt", message: "private" });
    expect(info).not.toHaveBeenCalled();
  });

  it("cannot interrupt the OTP flow when the logging sink fails", () => {
    info.mockImplementation(() => { throw new Error("sink unavailable"); });
    expect(() => logOtpEvent({ stage: "challenge", decision: "started" })).not.toThrow();
  });
});

describe("diagnostic scalar validation", () => {
  it("accepts a UUID correlation ID and rejects identity-like strings or malformed variants", () => {
    expect(isOtpCorrelationId(correlationId)).toBe(true);
    for (const value of [null, {}, "+972521234567", ` ${correlationId}`, correlationId.replace("40a2", "00a2"), correlationId.replace("9e22", "0e22")]) {
      expect(isOtpCorrelationId(value)).toBe(false);
    }
  });

  it.each([undefined, null, new Date(), "2026-02-30T12:00:00.000Z", "2026-08-23T12:00:00Z", "2026-08-23T12:00:00.000+00:00", "2026-99-99T99:99:99.000Z"])(
    "rejects noncanonical or impossible ISO time %j", (value) => {
      expect(isOtpIsoTime(value)).toBe(false);
    },
  );

  it("accepts canonical valid UTC instants", () => {
    expect(isOtpIsoTime("2026-08-23T12:00:00.000Z")).toBe(true);
    expect(isOtpIsoTime("2024-02-29T23:59:59.999Z")).toBe(true);
  });
});
