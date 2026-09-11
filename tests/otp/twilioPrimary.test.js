import { describe, expect, it, vi } from "vitest";
import { createOtpChallenge } from "@/lib/otp/challengeService";
import { createOtpChallengeStore } from "@/lib/otp/challengeStore";
import { requestTwilioSend } from "@/lib/otp/twilioSend";
import { completeOtpChallenge } from "@/lib/otp/completionService";
import { verifyCustomerSession } from "@/lib/customerSession";
import { hashBearerToken } from "@/lib/otp/crypto";
import { MemoryMongoCollection } from "../helpers/memoryOtpStores";

const PHONE = "+972500000001";
const SID = `VE${"a".repeat(32)}`;
const env = { NODE_ENV: "test", CUSTOMER_SESSION_SECRET: "s".repeat(48) };

async function fixture(purpose = "login") {
  let now = new Date("2026-09-11T10:00:00Z");
  const clock = { now: () => new Date(now) };
  const collection = new MemoryMongoCollection();
  const challengeStore = createOtpChallengeStore({ collection });
  const rateStore = {
    claimSourceAction: vi.fn(async () => {}),
    claimPhoneStart: vi.fn(async () => ({ retryAt: new Date(+now + 60_000).toISOString() })),
    claimGlobalSend: vi.fn(async () => {}),
    reservePhoneVerifyAttempt: vi.fn(async () => ({ verifyFailureCount: 1 })),
    clearPhoneVerifyFailures: vi.fn(async () => {}),
  };
  const deps = {
    clock, env, challengeStore, rateStore, deriveSourceHash: () => "source-one",
    sendVerification: vi.fn(async () => ({ sid: SID, status: "pending", to: PHONE, channel: "sms" })),
    verifyTwilioCode: vi.fn(async () => ({ sid: SID, status: "approved", to: PHONE })),
    usersData: { findOne: vi.fn(async () => ({ firstName: "Test", lastName: "Customer" })) },
  };
  const prepared = await createOtpChallenge({ phone: PHONE, purpose }, deps);
  const input = { challengeToken: prepared.challengeToken, purpose, code: "654321" };
  return {
    deps, collection, prepared, input,
    send: () => requestTwilioSend(input, deps),
    complete: (extra = {}) => completeOtpChallenge({ ...input, ...extra }, deps),
    current: () => challengeStore.findByTokenHash(hashBearerToken(input.challengeToken)),
    advance: (ms) => { now = new Date(+now + ms); },
  };
}

describe("Twilio primary durable workflow", () => {
  it("prepares Twilio in all environments, without sending until the send endpoint", async () => {
    const f = await fixture();
    expect(f.prepared.provider).toBe("twilio");
    expect(f.deps.sendVerification).not.toHaveBeenCalled();
    expect(f.prepared).not.toHaveProperty("profile");
  });

  it("sends once and recovers a saved result on replay", async () => {
    const f = await fixture();
    expect(await f.send()).toMatchObject({ provider: "twilio", status: "pending" });
    expect(await f.send()).toMatchObject({ status: "pending" });
    expect(f.deps.sendVerification).toHaveBeenCalledTimes(1);
    expect(f.deps.rateStore.claimGlobalSend).toHaveBeenCalledTimes(1);
  });

  it("fences concurrent sends before invoking the paid provider", async () => {
    const f = await fixture();
    await Promise.allSettled(Array.from({ length: 10 }, () => f.send()));
    expect(f.deps.sendVerification).toHaveBeenCalledTimes(1);
  });

  it("recovers observed send result after persistence outage without resending", async () => {
    const f = await fixture();
    const original = f.deps.challengeStore.transition;
    f.deps.challengeStore.transition = (value, ...rest) => value.patch.status === "sent"
      ? Promise.reject(new Error("write unavailable")) : original(value, ...rest);
    const error = await f.send().catch((e) => e);
    expect(error.code).toBe("OTP_PERSISTENCE_FAILED");
    expect(error.recoveryReceipt).toEqual(expect.any(String));
    f.deps.challengeStore.transition = original;
    expect(await requestTwilioSend({ ...f.input, recoveryReceipt: error.recoveryReceipt }, f.deps)).toMatchObject({ status: "pending" });
    expect(f.deps.sendVerification).toHaveBeenCalledTimes(1);
  });

  it("rejects a tampered or cross-operation receipt", async () => {
    const f = await fixture();
    await expect(requestTwilioSend({ ...f.input, recoveryReceipt: "forged" }, f.deps)).rejects.toMatchObject({ code: "OTP_RECOVERY_INVALID" });
    expect(f.deps.sendVerification).not.toHaveBeenCalled();
  });

  it.each([undefined, "approved", "failed", "unexpected"])("does not accept send status %s", async (status) => {
    const f = await fixture();
    f.deps.sendVerification.mockResolvedValue({ sid: SID, status, to: PHONE });
    await expect(f.send()).rejects.toHaveProperty("code");
    await expect(f.complete()).rejects.toHaveProperty("code");
    expect(f.deps.verifyTwilioCode).not.toHaveBeenCalled();
  });

  it("does not replay an ambiguous SMS request", async () => {
    const f = await fixture();
    f.deps.sendVerification.mockRejectedValue(Object.assign(new Error("timeout"), { code: "ETIMEDOUT" }));
    await expect(f.send()).rejects.toMatchObject({ code: "OTP_SEND_PENDING" });
    await expect(f.send()).rejects.toMatchObject({ code: "OTP_SEND_PENDING" });
    expect(f.deps.sendVerification).toHaveBeenCalledTimes(1);
  });

  it("requires matching source and purpose before sending/completing", async () => {
    const f = await fixture();
    await expect(requestTwilioSend(f.input, { ...f.deps, deriveSourceHash: () => "other-source" })).rejects.toHaveProperty("code");
    await f.send();
    await expect(f.complete({ purpose: "booking" })).rejects.toMatchObject({ code: "OTP_PURPOSE_MISMATCH" });
    expect(f.deps.verifyTwilioCode).not.toHaveBeenCalled();
  });

  it("creates and replays the same session without rechecking approval", async () => {
    const f = await fixture();
    await f.send();
    const first = await f.complete();
    f.advance(1000);
    const replay = await f.complete({ code: "" });
    expect(first.purpose).toBe("login");
    expect(replay.sessionToken).toBe(first.sessionToken);
    expect(await verifyCustomerSession(first.sessionToken, { env, now: f.deps.clock.now() })).toMatchObject({ phone: PHONE });
    expect(f.deps.verifyTwilioCode).toHaveBeenCalledExactlyOnceWith(PHONE, "654321", SID);
  });

  it("persists approval before signing so a signing failure can recover", async () => {
    const f = await fixture();
    await f.send();
    f.deps.signCustomerSession = vi.fn().mockRejectedValueOnce(new Error("sign failed"));
    await expect(f.complete()).rejects.toHaveProperty("code");
    expect((await f.current()).status).toBe("approved");
    delete f.deps.signCustomerSession;
    expect((await f.complete()).purpose).toBe("login");
    expect(f.deps.verifyTwilioCode).toHaveBeenCalledTimes(1);
  });

  it("recovers an observed approval via receipt without another provider check", async () => {
    const f = await fixture();
    await f.send();
    const original = f.deps.challengeStore.transition;
    f.deps.challengeStore.transition = (value, ...rest) => value.patch.status === "approved"
      ? Promise.reject(new Error("write unavailable")) : original(value, ...rest);
    const error = await f.complete().catch((e) => e);
    expect(error.code).toBe("OTP_PERSISTENCE_FAILED");
    expect(error.recoveryReceipt).toEqual(expect.any(String));
    f.deps.challengeStore.transition = original;
    expect((await f.complete({ recoveryReceipt: error.recoveryReceipt })).purpose).toBe("login");
    expect(f.deps.verifyTwilioCode).toHaveBeenCalledTimes(1);
  });

  it("retains booking approval through a profile read failure", async () => {
    const f = await fixture("booking");
    await f.send();
    f.deps.usersData.findOne.mockRejectedValueOnce(new Error("profile unavailable"));
    f.deps.issueBookingGrant = vi.fn(async () => ({ verificationToken: "test-grant" }));
    await expect(f.complete()).rejects.toHaveProperty("code");
    expect((await f.complete()).profile).toMatchObject({ hasCompleteName: true });
    expect(f.deps.verifyTwilioCode).toHaveBeenCalledTimes(1);
  });

  it("fences concurrent code checks and does not create duplicate sessions", async () => {
    const f = await fixture();
    await f.send();
    const outcomes = await Promise.allSettled(Array.from({ length: 10 }, () => f.complete()));
    const tokens = outcomes.filter((r) => r.status === "fulfilled").map((r) => r.value.sessionToken);
    expect(tokens.length).toBeGreaterThan(0);
    expect(new Set(tokens).size).toBe(1);
    expect(f.deps.verifyTwilioCode).toHaveBeenCalledTimes(1);
  });

  it.each(["pending", "expired", "failed", "unexpected", undefined])("does not approve verification status %s", async (status) => {
    const f = await fixture();
    await f.send();
    f.deps.verifyTwilioCode.mockResolvedValue({ sid: SID, status, to: PHONE });
    await expect(f.complete()).rejects.toHaveProperty("code");
    expect((await f.current()).status).not.toBe("approved");
    expect((await f.current()).status).not.toBe("completed");
  });

  it("rejects approval for another phone or SID", async () => {
    const f = await fixture();
    await f.send();
    f.deps.verifyTwilioCode.mockResolvedValue({ sid: SID, status: "approved", to: "+972500000002" });
    await expect(f.complete()).rejects.toMatchObject({ code: "OTP_VERIFY_TEMPORARY_FAILURE" });
  });

  it("does not repeat an ambiguous approval check or infer success from 404", async () => {
    const f = await fixture();
    await f.send();
    f.deps.verifyTwilioCode.mockRejectedValue(Object.assign(new Error("socket timeout"), { code: "ETIMEDOUT" }));
    await expect(f.complete()).rejects.toMatchObject({ code: "OTP_VERIFY_TEMPORARY_FAILURE" });
    await expect(f.complete()).rejects.toHaveProperty("code");
    expect(f.deps.verifyTwilioCode).toHaveBeenCalledTimes(1);
  });
});
