import { describe, expect, it, vi } from "vitest";
import { createOtpChallenge } from "@/lib/otp/challengeService";
import { createOtpChallengeStore } from "@/lib/otp/challengeStore";
import { requestFirebaseSend, requestFirebaseFallback } from "@/lib/otp/firebaseSend";
import { requestTwilioSend } from "@/lib/otp/twilioSend";
import { completeOtpChallenge } from "@/lib/otp/completionService";
import { hashBearerToken } from "@/lib/otp/crypto";
import { verifyCustomerSession } from "@/lib/customerSession";
import { OtpError } from "@/lib/otp/errors";
import { MemoryMongoCollection } from "../helpers/memoryOtpStores";

vi.mock("server-only", () => ({}));

const PHONE = "+972500000001";
const SID = `VE${"a".repeat(32)}`;
const failure = { code: "auth/network-request-failed", stage: "send", provenance: "firebase_sdk" };

async function fixture(purpose = "login", mode = "firebase_first") {
  const now = new Date("2026-09-11T10:00:00Z");
  const collection = new MemoryMongoCollection();
  const challengeStore = createOtpChallengeStore({ collection });
  const env = { NODE_ENV: "test", OTP_PROVIDER_MODE: mode, CUSTOMER_SESSION_SECRET: "s".repeat(48) };
  const rateStore = {
    claimSourceAction: vi.fn(async () => {}),
    claimPhoneStart: vi.fn(async () => ({ retryAt: new Date(+now + 60_000).toISOString() })),
    claimGlobalSend: vi.fn(async () => {}),
    reservePhoneVerifyAttempt: vi.fn(async () => ({ verifyFailureCount: 1 })),
  };
  const deps = { env, clock: { now: () => now }, challengeStore, rateStore,
    deriveSourceHash: () => "source-one",
    sendVerification: vi.fn(async () => ({ sid: SID, status: "pending", to: PHONE, channel: "sms" })),
    verifyTwilioCode: vi.fn(async () => ({ sid: SID, status: "approved", to: PHONE })),
    verifyFirebaseEvidence: vi.fn(async () => ({ uid: "firebase-test-user", authTime: +now / 1000 })),
    usersData: { findOne: vi.fn(async () => ({ firstName: "Test", lastName: "Customer" })) },
  };
  const prepared = await createOtpChallenge({ phone: PHONE, purpose, provider: "twilio" }, deps);
  const input = { challengeToken: prepared.challengeToken, purpose };
  const current = () => challengeStore.findByTokenHash(hashBearerToken(input.challengeToken));
  const reserve = () => requestFirebaseSend({ ...input, operation: "reserve" }, deps);
  return { collection, deps, prepared, input, current, reserve,
    accepted: (firebaseSendId) => requestFirebaseSend({ ...input, operation: "accepted", firebaseSendId }, deps),
    fallback: (firebaseSendId, extra = {}) => requestFirebaseFallback({ ...input, firebaseSendId, failure, ...extra }, deps),
    complete: (extra = {}) => completeOtpChallenge({ ...input, idToken: "mock-signed-id-token-for-server-test", ...extra }, deps),
  };
}

describe("Firebase primary server ownership", () => {
  it("retains only a bounded client-reported send rejection code in diagnostics", async () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    try {
      const f = await fixture();
      const { firebaseSendId } = await f.reserve();
      await requestFirebaseSend({ ...f.input, firebaseSendId, operation: "rejected",
        failure: { code: "auth/too-many-requests", stage: "send", provenance: "firebase_sdk", message: "private-provider-payload" } }, f.deps);
      expect(info).toHaveBeenCalledWith("OTP flow", expect.objectContaining({
        correlationId: f.prepared.correlationId, stage: "firebase_send_rejected", errorCode: "auth/too-many-requests", reason: "client_reported",
      }));
      expect((await f.current()).status).toBe("failed");
      expect(f.deps.sendVerification).not.toHaveBeenCalled();
      expect(JSON.stringify(info.mock.calls)).not.toContain("private-provider-payload");
    } finally { info.mockRestore(); }
  });

  it("recovers a lost successful completion response even when the browser retains a consumed retry receipt", async () => {
    const f = await fixture();
    await f.reserve();
    f.deps.verifyFirebaseEvidence.mockRejectedValueOnce(new OtpError("OTP_VERIFY_TEMPORARY_FAILURE", 503, "offline"));
    const error = await f.complete().catch((value) => value);
    expect(error.recoveryReceipt).toEqual(expect.any(String));
    const result = await f.complete({ recoveryReceipt: error.recoveryReceipt });
    expect(await f.complete({ recoveryReceipt: error.recoveryReceipt })).toMatchObject({ sessionToken: result.sessionToken });
    expect(f.deps.verifyFirebaseEvidence).toHaveBeenCalledTimes(2);
  });

  it("recovers an unacknowledged verification reservation after every reconciliation read fails", async () => {
    const f = await fixture();
    await f.reserve();
    const transition = f.deps.challengeStore.transition;
    const find = f.deps.challengeStore.findByTokenHash;
    let offline = false;
    f.deps.challengeStore.transition = async (value, ...args) => {
      if (offline) throw new Error("database offline");
      const saved = await transition(value, ...args);
      if (value.patch.status === "verifying") { offline = true; throw new Error("acknowledgement lost"); }
      return saved;
    };
    f.deps.challengeStore.findByTokenHash = (...args) => offline ? Promise.reject(new Error("database offline")) : find(...args);
    const error = await f.complete().catch((value) => value);
    expect(error).toMatchObject({ code: "OTP_PERSISTENCE_FAILED", recoveryReceipt: expect.any(String) });
    expect(f.deps.verifyFirebaseEvidence).not.toHaveBeenCalled();
    f.deps.challengeStore.transition = transition;
    f.deps.challengeStore.findByTokenHash = find;
    expect(await f.complete({ recoveryReceipt: error.recoveryReceipt })).toHaveProperty("sessionToken");
    expect(f.deps.verifyFirebaseEvidence).toHaveBeenCalledTimes(1);
  });

  it.each([false, true])("recovers a reservation that never committed (reads unavailable: %s)", async (failReads) => {
    const f = await fixture();
    await f.reserve();
    const transition = f.deps.challengeStore.transition;
    const find = f.deps.challengeStore.findByTokenHash;
    let attempted = false;
    f.deps.challengeStore.transition = async (value, ...args) => {
      if (value.patch.status === "verifying") { attempted = true; throw new Error("not committed"); }
      return transition(value, ...args);
    };
    f.deps.challengeStore.findByTokenHash = (...args) => failReads && attempted ? Promise.reject(new Error("offline")) : find(...args);
    const error = await f.complete().catch((value) => value);
    expect(error).toMatchObject({ code: "OTP_PERSISTENCE_FAILED", recoveryReceipt: expect.any(String) });
    f.deps.challengeStore.transition = transition;
    f.deps.challengeStore.findByTokenHash = find;
    expect(await f.complete({ recoveryReceipt: error.recoveryReceipt })).toHaveProperty("sessionToken");
    expect(f.deps.verifyFirebaseEvidence).toHaveBeenCalledTimes(1);
  });

  it("a late send acceptance cannot invalidate uncommitted reservation recovery", async () => {
    const f = await fixture();
    const { firebaseSendId } = await f.reserve();
    const transition = f.deps.challengeStore.transition;
    f.deps.challengeStore.transition = async (value, ...args) => {
      if (value.patch.status === "verifying") throw new Error("not committed");
      return transition(value, ...args);
    };
    const error = await f.complete().catch((value) => value);
    f.deps.challengeStore.transition = transition;
    await f.accepted(firebaseSendId);
    expect(await f.complete({ recoveryReceipt: error.recoveryReceipt })).toHaveProperty("sessionToken");
    expect(f.deps.verifyFirebaseEvidence).toHaveBeenCalledTimes(1);
  });

  it("classifies concurrent completion ownership as conflict, never database failure", async () => {
    const f = await fixture();
    await f.reserve();
    const results = await Promise.allSettled(Array.from({ length: 10 }, () => f.complete()));
    expect(results.filter((value) => value.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((value) => value.status === "rejected").map((value) => value.reason.code)).toEqual(Array(9).fill("OTP_COMPLETION_IN_PROGRESS"));
    expect(f.deps.verifyFirebaseEvidence).toHaveBeenCalledTimes(1);
  });

  it.each(["status", "fallback"])("allows a fresh attempt after expired %s recovery", async (operation) => {
    const f = await fixture();
    const { firebaseSendId } = await f.reserve();
    const before = +f.deps.clock.now();
    f.deps.clock.now = () => new Date(before + 20 * 60_000);
    const result = operation === "fallback" ? f.fallback(firebaseSendId) : requestFirebaseSend({ ...f.input, operation }, f.deps);
    await expect(result).rejects.toMatchObject({ code: "OTP_CHALLENGE_EXPIRED", restartAllowed: true });
    expect(f.deps.sendVerification).not.toHaveBeenCalled();
  });

  it("reconciles a committed verification reservation whose database acknowledgement was lost", async () => {
    const f = await fixture();
    await f.reserve();
    const original = f.deps.challengeStore.transition;
    let loseOnce = true;
    f.deps.challengeStore.transition = async (v, ...args) => {
      const saved = await original(v, ...args);
      if (v.patch.status === "verifying" && loseOnce) { loseOnce = false; throw new Error("lost acknowledgement"); }
      return saved;
    };
    expect((await f.complete()).purpose).toBe("login");
    expect(f.deps.verifyFirebaseEvidence).toHaveBeenCalledTimes(1);
  });

  it("never reopens fallback after a failed verification, including concurrent acceptance", async () => {
    const f = await fixture();
    const { firebaseSendId } = await f.reserve();
    f.deps.verifyFirebaseEvidence.mockImplementationOnce(async () => {
      expect(await f.accepted(firebaseSendId)).toMatchObject({ status: "pending" });
      throw new OtpError("OTP_VERIFY_TEMPORARY_FAILURE", 503, "certificate offline");
    });
    await expect(f.complete()).rejects.toMatchObject({ code: "OTP_VERIFY_TEMPORARY_FAILURE" });
    expect(await f.current()).toMatchObject({ status: "firebase_sent", firebaseAcceptedAt: expect.any(Date) });
    await expect(f.fallback(firebaseSendId)).rejects.toHaveProperty("code");
    expect(f.deps.sendVerification).not.toHaveBeenCalled();
  });

  it("recovers a failed evidence check whose rollback could not persist, without treating failure as approval", async () => {
    const f = await fixture();
    await f.reserve();
    const original = f.deps.challengeStore.transition;
    f.deps.challengeStore.transition = (v, ...args) => v.from === "verifying" && v.patch.status !== "approved" ? Promise.reject(new Error("write outage")) : original(v, ...args);
    f.deps.verifyFirebaseEvidence.mockRejectedValueOnce(new OtpError("OTP_VERIFY_TEMPORARY_FAILURE", 503, "certificate offline"));
    const error = await f.complete().catch((value) => value);
    expect(error).toMatchObject({ recoveryReceipt: expect.any(String) });
    expect((await f.current()).status).toBe("verifying");
    f.deps.challengeStore.transition = original;
    await expect(f.complete({ idToken: undefined, recoveryReceipt: error.recoveryReceipt })).rejects.toMatchObject({ code: "OTP_EVIDENCE_REQUIRED" });
    expect((await f.current()).status).toBe("firebase_sent");
    expect((await f.complete()).purpose).toBe("login");
    expect(f.deps.verifyFirebaseEvidence).toHaveBeenCalledTimes(2);
  });

  it("freezes server policy and normalized identity without accepting browser provider choice", async () => {
    const f = await fixture();
    expect(f.prepared).toMatchObject({ provider: "firebase", phone: PHONE, purpose: "login" });
    expect(await f.current()).toMatchObject({ provider: "firebase", providerPolicy: "firebase_first", status: "prepared" });
    f.deps.env.OTP_PROVIDER_MODE = "twilio_only";
    expect(await f.reserve()).toMatchObject({ provider: "firebase", status: "reserved", phone: PHONE });
    expect(f.deps.sendVerification).not.toHaveBeenCalled();
  });

  it("Twilio-only mode still dispatches directly and never permits fallback", async () => {
    const f = await fixture("login", "twilio_only");
    expect(f.prepared.provider).toBe("twilio");
    await expect(f.fallback("invented-id")).rejects.toHaveProperty("code");
    await requestTwilioSend(f.input, f.deps);
    expect(f.deps.sendVerification).toHaveBeenCalledTimes(1);
  });

  it("rejects an unknown configured mode instead of silently selecting a provider", async () => {
    await expect(fixture("login", "typo-mode")).rejects.toMatchObject({ code: "OTP_SERVICE_NOT_CONFIGURED" });
  });

  it("reserves Firebase once; replay of a lost response never authorizes another SDK send", async () => {
    const f = await fixture();
    const outcomes = await Promise.all(Array.from({ length: 10 }, () => f.reserve()));
    expect(outcomes.filter((v) => v.status === "reserved")).toHaveLength(1);
    expect(outcomes.filter((v) => v.status === "sending")).toHaveLength(9);
    expect(new Set(outcomes.map((v) => v.firebaseSendId)).size).toBe(1);
  });

  it("records accepted sends idempotently and blocks later fallback", async () => {
    const f = await fixture();
    const { firebaseSendId } = await f.reserve();
    expect(await f.accepted(firebaseSendId)).toMatchObject({ status: "pending" });
    expect(await f.accepted(firebaseSendId)).toMatchObject({ status: "pending" });
    await expect(f.fallback(firebaseSendId)).rejects.toHaveProperty("code");
    expect(f.deps.sendVerification).not.toHaveBeenCalled();
  });

  it("switches the same challenge once and does not reapply its own phone cooldown", async () => {
    const f = await fixture();
    const { firebaseSendId } = await f.reserve();
    const id = (await f.current())._id;
    expect(await f.fallback(firebaseSendId)).toMatchObject({ provider: "twilio", status: "pending" });
    expect(await f.fallback(firebaseSendId)).toMatchObject({ provider: "twilio", status: "pending" });
    expect((await f.current())._id.equals(id)).toBe(true);
    expect(f.deps.rateStore.claimPhoneStart).toHaveBeenCalledTimes(1);
    expect(f.deps.rateStore.claimGlobalSend).toHaveBeenCalledTimes(1);
    expect(f.deps.sendVerification).toHaveBeenCalledTimes(1);
  });

  it.each(["auth/too-many-requests", "auth/invalid-phone-number", "auth/missing-phone-number", "auth/invalid-verification-code", "auth/code-expired", "auth/unauthorized-domain", "auth/invalid-api-key", "auth/operation-not-allowed", "auth/quota-exceeded", "auth/user-disabled", "auth/recaptcha-not-enabled"])("rejects ineligible report %s without Twilio", async (code) => {
    const f = await fixture();
    const { firebaseSendId } = await f.reserve();
    await expect(f.fallback(firebaseSendId, { failure: { ...failure, code } })).rejects.toHaveProperty("code");
    expect(f.deps.sendVerification).not.toHaveBeenCalled();
    expect((await f.current()).provider).toBe("firebase");
  });

  it.each([
    { code: "auth/internal-error", stage: "firebase_code_confirm", provenance: "firebase_sdk" },
    { code: "auth/unknown", stage: "firebase_send_rejected", provenance: "javascript" },
    { stage: "firebase_send_rejected", provenance: "firebase_sdk" },
  ])("rejects wrong-stage or unclassified reports: %j", async (report) => {
    const f = await fixture();
    const { firebaseSendId } = await f.reserve();
    await expect(f.fallback(firebaseSendId, { failure: report })).rejects.toHaveProperty("code");
    expect(f.deps.sendVerification).not.toHaveBeenCalled();
  });

  it("checks source and reservation binding before fallback", async () => {
    const f = await fixture();
    const { firebaseSendId } = await f.reserve();
    await expect(f.fallback("another-reservation")).rejects.toHaveProperty("code");
    await expect(requestFirebaseFallback({ ...f.input, firebaseSendId, failure }, { ...f.deps, deriveSourceHash: () => "other" })).rejects.toHaveProperty("code");
    expect(f.deps.sendVerification).not.toHaveBeenCalled();
  });

  it("fences concurrent fallback requests to a single Twilio dispatch", async () => {
    const f = await fixture();
    const { firebaseSendId } = await f.reserve();
    await Promise.allSettled(Array.from({ length: 10 }, () => f.fallback(firebaseSendId)));
    expect(f.deps.sendVerification).toHaveBeenCalledTimes(1);
  });

  it("replays a recovered fallback send after persistence outage without a second SMS", async () => {
    const f = await fixture();
    const { firebaseSendId } = await f.reserve();
    const original = f.deps.challengeStore.transition;
    f.deps.challengeStore.transition = (v, ...args) => v.patch.status === "sent" ? Promise.reject(new Error("offline")) : original(v, ...args);
    const error = await f.fallback(firebaseSendId).catch((e) => e);
    expect(error).toMatchObject({ code: "OTP_PERSISTENCE_FAILED", recoveryReceipt: expect.any(String) });
    f.deps.challengeStore.transition = original;
    expect(await f.fallback(firebaseSendId, { recoveryReceipt: error.recoveryReceipt })).toMatchObject({ status: "pending" });
    expect(f.deps.sendVerification).toHaveBeenCalledTimes(1);
  });

  it("Firebase success creates the same phone-based customer session and never calls Twilio", async () => {
    const f = await fixture();
    const { firebaseSendId } = await f.reserve();
    await f.accepted(firebaseSendId);
    const result = await f.complete();
    expect(await verifyCustomerSession(result.sessionToken, { env: f.deps.env, now: f.deps.clock.now() })).toMatchObject({ phone: PHONE });
    expect(await f.complete()).toMatchObject({ sessionToken: result.sessionToken });
    expect(f.deps.verifyFirebaseEvidence).toHaveBeenCalledTimes(1);
    expect(f.deps.verifyTwilioCode).not.toHaveBeenCalled();
    expect(f.deps.sendVerification).not.toHaveBeenCalled();
  });

  it("Firebase evidence cannot complete a Twilio-owned challenge, even with a code field", async () => {
    const f = await fixture();
    const { firebaseSendId } = await f.reserve();
    await f.fallback(firebaseSendId);
    await expect(f.complete({ code: "654321" })).rejects.toHaveProperty("code");
    expect(f.deps.verifyFirebaseEvidence).not.toHaveBeenCalled();
    expect(f.deps.verifyTwilioCode).not.toHaveBeenCalled();
  });

  it("completion wins ownership before evidence checking, blocking competing fallback", async () => {
    const f = await fixture();
    const { firebaseSendId } = await f.reserve();
    f.deps.verifyFirebaseEvidence.mockImplementation(async () => {
      await expect(f.fallback(firebaseSendId)).rejects.toHaveProperty("code");
      return { uid: "verified-user", authTime: +f.deps.clock.now() / 1000 };
    });
    expect((await f.complete()).purpose).toBe("login");
    expect(f.deps.sendVerification).not.toHaveBeenCalled();
  });

  it("recovers persisted Firebase approval after application signing failure without another Admin check", async () => {
    const f = await fixture();
    await f.reserve();
    f.deps.signCustomerSession = vi.fn().mockRejectedValueOnce(new Error("signing offline"));
    await expect(f.complete()).rejects.toHaveProperty("code");
    expect((await f.current()).status).toBe("approved");
    delete f.deps.signCustomerSession;
    expect((await f.complete()).purpose).toBe("login");
    expect(f.deps.verifyFirebaseEvidence).toHaveBeenCalledTimes(1);
  });

  it("recovers observed Firebase approval with an encrypted receipt after database failure", async () => {
    const f = await fixture();
    await f.reserve();
    const original = f.deps.challengeStore.transition;
    f.deps.challengeStore.transition = (v, ...args) => v.patch.status === "approved" ? Promise.reject(new Error("offline")) : original(v, ...args);
    const error = await f.complete().catch((e) => e);
    expect(error).toMatchObject({ code: "OTP_PERSISTENCE_FAILED", recoveryReceipt: expect.any(String) });
    f.deps.challengeStore.transition = original;
    expect((await f.complete({ idToken: undefined, recoveryReceipt: error.recoveryReceipt })).purpose).toBe("login");
    expect(f.deps.verifyFirebaseEvidence).toHaveBeenCalledTimes(1);
  });
});
