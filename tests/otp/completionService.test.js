import { beforeEach, describe, expect, it, vi } from "vitest";
import { ObjectId } from "mongodb";
import { completeOtpChallenge } from "@/lib/otp/completionService";
import { createOtpChallengeStore } from "@/lib/otp/challengeStore";
import { deriveBookingToken, hashBearerToken } from "@/lib/otp/crypto";
import { OtpError } from "@/lib/otp/errors";
import { createTestClock, MemoryMongoCollection } from "../helpers/memoryOtpStores";

const { getCollection } = vi.hoisted(() => ({ getCollection: vi.fn() }));
vi.mock("@/lib/db", () => ({ getCollection }));

const PHONE = "+972501234567";
const SID = `VE${"a".repeat(32)}`;
const TOKEN = "a".repeat(43);
const TOKEN_HASH = hashBearerToken(TOKEN);
const CORRELATION_ID = "061a1297-e394-40a2-9e22-fc63b2c186a1";

function fixture(changes = {}) {
  const clock = createTestClock();
  const challenge = {
    _id: new ObjectId(), challengeTokenHash: TOKEN_HASH, phone: PHONE,
    purpose: "booking", provider: "twilio", status: "sent", verificationSid: SID,
    sourceHash: "source-hash", correlationId: CORRELATION_ID,
    createdAt: new Date(+clock.now() - 60_000), expiresAt: new Date(+clock.now() + 300_000),
    ...changes,
  };
  const collection = new MemoryMongoCollection([challenge]);
  const challengeStore = createOtpChallengeStore({ collection });
  vi.spyOn(challengeStore, "findByTokenHash");
  vi.spyOn(challengeStore, "transition");
  const deps = {
    clock, challengeStore, env: { NODE_ENV: "test", CUSTOMER_SESSION_SECRET: "s".repeat(48) },
    rateStore: { reservePhoneVerifyAttempt: vi.fn().mockResolvedValue({ verifyFailureCount: 1 }) },
    verifyTwilioCode: vi.fn().mockResolvedValue({ sid: SID, status: "approved", to: PHONE }),
    usersData: { findOne: vi.fn().mockResolvedValue({ firstName: "  Ada ", lastName: " Lovelace  ", notes: ["private-note"] }) },
    issueBookingGrant: vi.fn(async ({ verificationToken }) => ({ verificationToken })),
    signCustomerSession: vi.fn().mockResolvedValue("session-token"),
  };
  const input = { challengeToken: TOKEN, purpose: challenge.purpose, code: "654321" };
  return { clock, collection, deps, input, complete: (extra = {}) => completeOtpChallenge({ ...input, ...extra }, deps) };
}

function expectNoIdentityDisclosure(deps) {
  expect(deps.usersData.findOne).not.toHaveBeenCalled();
  expect(deps.issueBookingGrant).not.toHaveBeenCalled();
  expect(deps.signCustomerSession).not.toHaveBeenCalled();
}

beforeEach(() => {
  getCollection.mockReset();
  getCollection.mockRejectedValue(new Error("Unexpected database access"));
  vi.spyOn(console, "info").mockImplementation(() => {});
});

describe("completion input and stored identity boundaries", () => {
  it.each([undefined, null, "", 123456, {}, [], "a".repeat(42), "a".repeat(44), `${"a".repeat(42)}!`, ` ${"a".repeat(42)}`])(
    "rejects malformed challenge token %j before lookup", async (challengeToken) => {
      const f = fixture();
      await expect(f.complete({ challengeToken })).rejects.toMatchObject({ code: "OTP_CHALLENGE_TOKEN_REQUIRED", status: 400 });
      expect(f.deps.challengeStore.findByTokenHash).not.toHaveBeenCalled();
      expect(f.deps.verifyTwilioCode).not.toHaveBeenCalled();
      expectNoIdentityDisclosure(f.deps);
    },
  );

  it.each([undefined, null])("rejects a missing payload %j without reading persistence", async (payload) => {
    const f = fixture();
    await expect(completeOtpChallenge(payload, f.deps)).rejects.toMatchObject({ code: "OTP_CHALLENGE_TOKEN_REQUIRED", status: 400 });
    expect(f.deps.challengeStore.findByTokenHash).not.toHaveBeenCalled();
    expect(getCollection).not.toHaveBeenCalled();
  });

  it.each([
    ["missing identity", { _id: undefined }], ["missing provider", { provider: undefined }],
    ["missing purpose", { purpose: undefined }], ["invalid purpose", { purpose: "admin" }],
    ["unnormalized phone", { phone: "0501234567" }], ["missing phone", { phone: null }],
    ["string expiry", { expiresAt: "2026-08-23T12:10:00.000Z" }], ["invalid expiry", { expiresAt: new Date(NaN) }],
  ])("rejects a stored challenge with %s before verification", async (_name, changes) => {
    const f = fixture(changes);
    await expect(f.complete()).rejects.toMatchObject({ code: "OTP_VERIFICATION_INVALID", status: 401 });
    expect(f.deps.challengeStore.transition).not.toHaveBeenCalled();
    expect(f.deps.verifyTwilioCode).not.toHaveBeenCalled();
    expectNoIdentityDisclosure(f.deps);
  });

  it("hashes an unknown bearer for lookup and discloses no customer identity", async () => {
    const f = fixture();
    const unknown = "b".repeat(43);
    await expect(f.complete({ challengeToken: unknown })).rejects.toMatchObject({ code: "OTP_VERIFICATION_INVALID", status: 401 });
    expect(f.deps.challengeStore.findByTokenHash).toHaveBeenCalledExactlyOnceWith(hashBearerToken(unknown));
    expect(f.deps.verifyTwilioCode).not.toHaveBeenCalled();
    expectNoIdentityDisclosure(f.deps);
  });

  it.each([undefined, null, "login", "booking ", ["booking"]])("requires the exact stored purpose, including for input %j", async (purpose) => {
    const f = fixture();
    await expect(f.complete({ purpose })).rejects.toMatchObject({ code: "OTP_PURPOSE_MISMATCH", status: 400 });
    expect(f.deps.challengeStore.transition).not.toHaveBeenCalled();
    expect(f.deps.verifyTwilioCode).not.toHaveBeenCalled();
    expectNoIdentityDisclosure(f.deps);
  });

  it.each([undefined, null, "", 654321, {}, ["654321"], "123", "12345678901", "12a456", " 654321", "654321 ", "1234\n"])(
    "rejects malformed code %j before reserving or checking an attempt", async (code) => {
      const f = fixture();
      await expect(f.complete({ code })).rejects.toMatchObject({ code: "INVALID_OTP", status: 401 });
      expect(f.deps.challengeStore.transition).not.toHaveBeenCalled();
      expect(f.deps.rateStore.reservePhoneVerifyAttempt).not.toHaveBeenCalled();
      expect(f.deps.verifyTwilioCode).not.toHaveBeenCalled();
      expectNoIdentityDisclosure(f.deps);
    },
  );

  it.each(["0000", "012345", "0123456789"])("passes valid numeric-string code %s unchanged", async (code) => {
    const f = fixture();
    await f.complete({ code });
    expect(f.deps.verifyTwilioCode).toHaveBeenCalledExactlyOnceWith(PHONE, code, SID);
  });

  it("uses only the stored phone and SID, and exposes only the minimized approved profile", async () => {
    const f = fixture();
    f.deps.usersData.findOne.mockImplementation(async () => {
      expect(f.collection.current.status).toBe("approved");
      expect(f.collection.current.approvedAt).toEqual(f.clock.now());
      return { firstName: "  Ada ", lastName: " Lovelace  ", phone: PHONE, _id: "private-id", notes: ["private-note"] };
    });
    const result = await f.complete({ phone: "+972599999999", verificationSid: `VE${"b".repeat(32)}`, profile: { firstName: "Injected" } });
    expect(f.deps.verifyTwilioCode).toHaveBeenCalledExactlyOnceWith(PHONE, "654321", SID);
    expect(f.deps.rateStore.reservePhoneVerifyAttempt).toHaveBeenCalledExactlyOnceWith(PHONE, expect.any(String));
    expect(f.deps.usersData.findOne).toHaveBeenCalledExactlyOnceWith({ phone: PHONE }, { projection: { firstName: 1, lastName: 1 } });
    expect(result).toEqual({
      success: true, purpose: "booking", verificationToken: deriveBookingToken(TOKEN, f.deps.env), expiresInSeconds: 600,
      profile: { hasCompleteName: true, firstName: "Ada", lastName: "Lovelace" },
    });
    expect(f.deps.issueBookingGrant).toHaveBeenCalledWith({
      challenge: expect.objectContaining({ phone: PHONE, purpose: "booking", status: "approved" }),
      challengeTokenHash: TOKEN_HASH, verificationToken: result.verificationToken,
    }, f.deps);
    expect(f.deps.signCustomerSession).not.toHaveBeenCalled();
    expect(JSON.stringify(f.collection.documents)).not.toContain(TOKEN);
    expect(JSON.stringify(f.collection.documents)).not.toContain("654321");
    expect(JSON.stringify(f.collection.documents)).not.toContain(result.verificationToken);
  });

  it.each([null, {}, { firstName: "Ada" }, { firstName: "Ada", lastName: " " }, { firstName: 42, lastName: "Name" }, { firstName: "Ada", lastName: ["Name"] }])(
    "does not disclose a partial or malformed profile %j", async (profile) => {
      const f = fixture();
      f.deps.usersData.findOne.mockResolvedValue(profile);
      expect((await f.complete()).profile).toEqual({ hasCompleteName: false });
      expect(f.deps.issueBookingGrant).toHaveBeenCalledTimes(1);
      expect(f.deps.signCustomerSession).not.toHaveBeenCalled();
    },
  );

  it("signs login for the stored identity without booking or profile access", async () => {
    const f = fixture({ purpose: "login" });
    f.deps.env.CUSTOMER_SESSION_TTL_SECONDS = "120";
    const result = await f.complete({ phone: "+972599999999" });
    expect(result).toEqual({ purpose: "login", sessionToken: "session-token", sessionTtlSeconds: 120 });
    expect(f.deps.signCustomerSession).toHaveBeenCalledExactlyOnceWith(PHONE, { env: f.deps.env, now: f.clock.now(), ttlSeconds: 120 });
    expect(f.collection.current).toMatchObject({ status: "completed", sessionTtlSeconds: 120, completedAt: f.clock.now() });
    expect(f.deps.usersData.findOne).not.toHaveBeenCalled();
    expect(f.deps.issueBookingGrant).not.toHaveBeenCalled();
    expect(JSON.stringify(f.collection.documents)).not.toContain(result.sessionToken);
  });
});

describe("completion expiry and configuration boundaries", () => {
  it.each(["prepared", "sending", "delivery_unknown", "failed"])("rejects unsent state %s without provider or PII access", async (status) => {
    const f = fixture({ status });
    await expect(f.complete()).rejects.toMatchObject({ code: "OTP_VERIFICATION_INVALID", status: 401 });
    expect(f.deps.verifyTwilioCode).not.toHaveBeenCalled();
    expectNoIdentityDisclosure(f.deps);
  });

  it.each([0, 1])("rejects the unapproved challenge at expiry plus %s ms", async (lateBy) => {
    const f = fixture();
    f.clock.advance(300_000 + lateBy);
    await expect(f.complete()).rejects.toMatchObject({ code: "OTP_VERIFICATION_EXPIRED", status: 401 });
    expect(f.deps.challengeStore.transition).not.toHaveBeenCalled();
    expect(f.deps.verifyTwilioCode).not.toHaveBeenCalled();
    expectNoIdentityDisclosure(f.deps);
  });

  it("rejects an approval first observed at the challenge deadline", async () => {
    const f = fixture();
    f.deps.verifyTwilioCode.mockImplementation(async () => {
      f.clock.advance(300_000);
      return { sid: SID, to: PHONE, status: "approved" };
    });
    await expect(f.complete()).rejects.toMatchObject({ code: "OTP_VERIFICATION_EXPIRED", status: 401 });
    expect(f.collection.current.status).toBe("verify_unknown");
    expect(f.collection.current).not.toHaveProperty("approvedAt");
    expectNoIdentityDisclosure(f.deps);
  });

  it("rejects expired completion authority even when approval is already durable", async () => {
    const f = fixture({
      status: "approved", approvedAt: new Date("2026-08-23T11:50:00.000Z"),
      completionExpiresAt: new Date("2026-08-23T12:00:00.000Z"),
    });
    await expect(f.complete()).rejects.toMatchObject({ code: "OTP_VERIFICATION_EXPIRED", status: 401 });
    expect(f.deps.verifyTwilioCode).not.toHaveBeenCalled();
    expectNoIdentityDisclosure(f.deps);
  });

  it.each(["development", "test", "production"])("does not accept OTP_DEV_CODE without Twilio approval in %s", async (NODE_ENV) => {
    const f = fixture();
    Object.assign(f.deps.env, { NODE_ENV, OTP_DEV_CODE: "654321" });
    f.deps.verifyTwilioCode.mockResolvedValue({ sid: SID, to: PHONE, status: "pending" });
    await expect(f.complete()).rejects.toMatchObject({ code: "INVALID_OTP", status: 401 });
    expect(f.deps.verifyTwilioCode).toHaveBeenCalledExactlyOnceWith(PHONE, "654321", SID);
    expect(f.collection.current.status).toBe("sent");
    expectNoIdentityDisclosure(f.deps);
  });

  it.each(["", "0", "-1", "1.5", "Infinity", "NaN", null, {}, "9007199254740992"])(
    "rejects invalid login TTL %j before checking a code", async (ttl) => {
      const f = fixture({ purpose: "login" });
      f.deps.env.CUSTOMER_SESSION_TTL_SECONDS = ttl;
      await expect(f.complete()).rejects.toMatchObject({ code: "OTP_COMPLETION_FAILED", status: 503 });
      expect(f.deps.challengeStore.transition).not.toHaveBeenCalled();
      expect(f.deps.verifyTwilioCode).not.toHaveBeenCalled();
      expectNoIdentityDisclosure(f.deps);
    },
  );

  it("does not apply login-session TTL settings to booking verification", async () => {
    const f = fixture();
    f.deps.env.CUSTOMER_SESSION_TTL_SECONDS = "invalid";
    await expect(f.complete()).resolves.toHaveProperty("purpose", "booking");
    expect(f.deps.signCustomerSession).not.toHaveBeenCalled();
  });

  it("does not verify or disclose PII when the phone reservation is blocked", async () => {
    const f = fixture();
    f.deps.rateStore.reservePhoneVerifyAttempt.mockRejectedValue(new OtpError("OTP_VERIFY_RATE_LIMITED", 429, "Limited"));
    await expect(f.complete()).rejects.toMatchObject({ code: "OTP_VERIFY_RATE_LIMITED", status: 429 });
    expect(f.collection.current.status).toBe("sent");
    expect(f.deps.verifyTwilioCode).not.toHaveBeenCalled();
    expectNoIdentityDisclosure(f.deps);
  });

  it("returns the lockout outcome on the fifth reserved wrong-code attempt", async () => {
    const f = fixture();
    f.deps.rateStore.reservePhoneVerifyAttempt.mockResolvedValue({ verifyFailureCount: 5 });
    f.deps.verifyTwilioCode.mockResolvedValue({ sid: SID, to: PHONE, status: "pending" });
    await expect(f.complete()).rejects.toMatchObject({ code: "OTP_VERIFY_RATE_LIMITED", status: 429 });
    expectNoIdentityDisclosure(f.deps);
  });

  it("keeps plaintext input, raw provider errors and opaque recovery receipts out of logs", async () => {
    const f = fixture();
    f.deps.usersData.findOne.mockRejectedValue(new Error(`private database error: ${PHONE} ${TOKEN}`));
    const error = await f.complete().catch((failure) => failure);
    expect(error).toMatchObject({ code: "OTP_PERSISTENCE_FAILED", recoveryReceipt: expect.any(String) });
    expect(error.recoveryReceipt.length).toBeGreaterThan(40);
    const logs = JSON.stringify(console.info.mock.calls);
    for (const privateValue of [PHONE, TOKEN, "654321", SID, "private database error", error.recoveryReceipt]) {
      expect(logs).not.toContain(privateValue);
    }
    expect(console.info).toHaveBeenCalledWith("OTP flow", {
      correlationId: CORRELATION_ID, stage: "complete", provider: "twilio", errorCode: "OTP_PERSISTENCE_FAILED", decision: "failed",
    });
    expect(f.deps.issueBookingGrant).not.toHaveBeenCalled();
    expect(f.deps.signCustomerSession).not.toHaveBeenCalled();
  });
});
