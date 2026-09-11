import { describe, expect, it, vi } from "vitest";
import { openOtpReceipt, sealOtpReceipt, persistObservedResult } from "@/lib/otp/recovery";
import { OTP_GRANT_TTL_MS } from "@/lib/otp/constants";

const env = { CUSTOMER_SESSION_SECRET: "s".repeat(48) };
const now = new Date("2026-09-11T10:00:01Z");
const challenge = { challengeTokenHash: "hash", phone: "+972500000001", purpose: "login",
  createdAt: new Date(+now - 1000), expiresAt: new Date(+now + 10000),
  sendAttemptId: "send", verifyAttemptId: "verify", verificationSid: `VE${"a".repeat(32)}` };
const send = { operation: "send", challengeTokenHash: challenge.challengeTokenHash, phone: challenge.phone,
  purpose: "login", attemptId: "send", verificationSid: challenge.verificationSid, observedAt: +now, expiresAt: +challenge.expiresAt };
const verify = { ...send, operation: "verify", attemptId: "verify", sessionTtlSeconds: 3600, expiresAt: +now + OTP_GRANT_TTL_MS };

describe("authenticated OTP recovery receipts", () => {
  it.each([send, verify])("recovers an observed $operation result without exposing its contents", (result) => {
    const receipt = sealOtpReceipt(result, env);
    expect(receipt).not.toContain(challenge.phone);
    expect(receipt).not.toContain(challenge.verificationSid);
    expect(openOtpReceipt(receipt, { challenge, operation: result.operation, now, env })).toEqual(result);
  });
  it.each([
    { operation: "verify" }, { phone: "+972500000002" }, { purpose: "booking" },
    { attemptId: "other" }, { challengeTokenHash: "other" }, { verificationSid: "invalid" },
    { observedAt: +now + 1 }, { observedAt: +challenge.createdAt - 1 },
    { expiresAt: undefined }, { expiresAt: +now }, { expiresAt: +now + 20000 },
  ])("rejects an incompatible result %j", (patch) => {
    const receipt = sealOtpReceipt({ ...send, ...patch }, env);
    expect(() => openOtpReceipt(receipt, { challenge, operation: "send", now, env })).toThrowError(expect.objectContaining({ code: "OTP_RECOVERY_INVALID" }));
  });
  it("rejects tampering, wrong keys, and missing session lifetime", () => {
    const receipt = sealOtpReceipt(send, env);
    const changedCharacter = receipt[50] === "A" ? "B" : "A";
    for (const [token, key] of [[`${receipt.slice(0, 50)}${changedCharacter}${receipt.slice(51)}`, env], [receipt, { CUSTOMER_SESSION_SECRET: "z".repeat(48) }]]) {
      expect(() => openOtpReceipt(token, { challenge, operation: "send", now, env: key })).toThrow();
    }
    const bad = sealOtpReceipt({ ...verify, sessionTtlSeconds: undefined }, env);
    expect(() => openOtpReceipt(bad, { challenge, operation: "verify", now, env })).toThrow();
  });
  it("allows approval recovery after original expiry but never after completion expiry", () => {
    const receipt = sealOtpReceipt(verify, env);
    expect(openOtpReceipt(receipt, { challenge, operation: "verify", now: new Date(+challenge.expiresAt + 1), env })).toEqual(verify);
    expect(() => openOtpReceipt(receipt, { challenge, operation: "verify", now: new Date(verify.expiresAt), env })).toThrow();
  });
  it("recovers an acknowledged write whose response was lost", async () => {
    const value = { status: "approved" };
    const store = { transition: vi.fn().mockRejectedValue(new Error("lost acknowledgement")), findByTokenHash: vi.fn().mockResolvedValue(value) };
    expect(await persistObservedResult(store, { challengeTokenHash: "hash" }, (v) => v.status === "approved")).toBe(value);
    expect(store.transition).toHaveBeenCalledTimes(1);
  });
  it("keeps write retries finite and cannot accept unrelated state", async () => {
    const store = { transition: vi.fn().mockResolvedValue(null), findByTokenHash: vi.fn().mockResolvedValue({ status: "sent" }) };
    await expect(persistObservedResult(store, { challengeTokenHash: "hash" }, (v) => v.status === "approved")).rejects.toMatchObject({ code: "OTP_PERSISTENCE_FAILED" });
    expect(store.transition).toHaveBeenCalledTimes(3);
  });
});
