import { beforeEach, describe, expect, it, vi } from "vitest";
import { ObjectId } from "mongodb";
import {
  consumeBookingGrant,
  issueBookingGrant,
  isTransactionUnsupportedError,
  OtpVerificationGrantError,
  releaseBookingGrant,
} from "@/lib/otp/bookingGrant";
import { createOtpChallengeStore } from "@/lib/otp/challengeStore";
import { hashBearerToken } from "@/lib/otp/crypto";
import {
  createTestClock,
  MemoryMongoClient,
  MemoryMongoCollection,
} from "../helpers/memoryOtpStores";

const database = vi.hoisted(() => ({ getCollection: vi.fn() }));
vi.mock("@/lib/db", () => database);

const CHALLENGE_HASH = "challenge-hash-a";
const TOKEN = "secret-derived-deterministic-verification-token";
const PHONE = "+972521234567";
const APPROVED_AT = new Date("2026-08-23T11:59:30.000Z");
const EXPIRES_AT = new Date("2026-08-23T12:09:30.000Z");
const UNSUPPORTED_MESSAGE =
  "Transaction numbers are only allowed on a replica set member or mongos";

function makeChallenge(overrides = {}) {
  return {
    _id: new ObjectId("68ab2ec00000000000000001"),
    challengeTokenHash: CHALLENGE_HASH,
    provider: "twilio",
    purpose: "booking",
    phone: PHONE,
    status: "approved",
    createdAt: new Date("2026-08-23T11:49:40.000Z"),
    expiresAt: new Date("2026-08-23T11:59:40.000Z"),
    approvedAt: APPROVED_AT,
    completionExpiresAt: EXPIRES_AT,
    ...overrides,
  };
}

function expectCode(promise, code) {
  return expect(promise).rejects.toMatchObject({ name: "OtpVerificationGrantError", code });
}

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

describe.each(["transaction", "standalone"])("booking grants: %s", (mode) => {
  let challenge;
  let challenges;
  let grants;
  let challengeStore;
  let client;
  let clock;
  let deps;

  beforeEach(() => {
    challenge = makeChallenge();
    clock = createTestClock();
    challenges = new MemoryMongoCollection([challenge]);
    grants = new MemoryMongoCollection();
    challenges.serverClock = clock;
    grants.serverClock = clock;
    challengeStore = createOtpChallengeStore({ collection: challenges });
    client = new MemoryMongoClient([challenges, grants], {
      transactionsUnsupported: mode === "standalone",
    });
    deps = { challenges, grants, challengeStore, client, clock };
  });

  function issue(overrides = {}) {
    return issueBookingGrant({
      challenge, challengeTokenHash: CHALLENGE_HASH, verificationToken: TOKEN, ...overrides,
    }, deps);
  }

  function consume(overrides = {}, dependencies = deps) {
    return consumeBookingGrant({
      phone: PHONE, verificationToken: TOKEN, appointmentId: "appointment-a", ...overrides,
    }, dependencies);
  }

  function release(overrides = {}) {
    return releaseBookingGrant({
      phone: PHONE, verificationToken: TOKEN, appointmentId: "appointment-a", ...overrides,
    }, deps);
  }

  function preparedGrant(overrides = {}) {
    return {
      challengeId: challenge._id,
      completionId: challenge._id,
      phone: PHONE,
      purpose: "booking",
      tokenHash: hashBearerToken(TOKEN),
      status: "prepared",
      used: false,
      usedAt: null,
      appointmentId: null,
      createdAt: APPROVED_AT,
      expiresAt: EXPIRES_AT,
      ...overrides,
    };
  }

  function publishCompleted(overrides = {}) {
    challenges.current = {
      ...challenge,
      status: "completed",
      completionId: challenge._id,
      bookingGrantTokenHash: hashBearerToken(TOKEN),
      completedAt: clock.now(),
      ...overrides,
    };
  }

  it("issues the supplied token after send expiry with an approval-based lifetime", async () => {
    await expect(issue()).resolves.toEqual({ verificationToken: TOKEN });
    expect(challenges.current).toMatchObject({
      status: "completed", completionId: challenge._id,
      bookingGrantTokenHash: hashBearerToken(TOKEN),
      approvedAt: APPROVED_AT, completionExpiresAt: EXPIRES_AT, expiresAt: challenge.expiresAt,
    });
    expect(grants.documents).toHaveLength(1);
    expect(grants.current).toMatchObject(preparedGrant());
    expect(JSON.stringify(grants.documents)).not.toContain(TOKEN);
    expect(JSON.stringify(challenges.documents)).not.toContain(TOKEN);
    expect(grants.indexes).toEqual(expect.arrayContaining([
      expect.objectContaining({ keys: { tokenHash: 1 }, options: expect.objectContaining({ unique: true }) }),
      expect.objectContaining({ keys: { challengeId: 1 }, options: expect.objectContaining({ unique: true }) }),
      expect.objectContaining({ keys: { expiresAt: 1 }, options: expect.objectContaining({ expireAfterSeconds: 0 }) }),
    ]));
    await expect(consume()).resolves.toMatchObject({ used: true, appointmentId: "appointment-a" });
  });

  it("replays the exact unused grant from stale approved and current completed inputs", async () => {
    await issue();
    const stored = grants.snapshot();
    clock.advance(60_000);
    await expect(issue()).resolves.toEqual({ verificationToken: TOKEN });
    await expect(issue({ challenge: challenges.current })).resolves.toEqual({ verificationToken: TOKEN });
    expect(grants.snapshot()).toEqual(stored);
    expect(grants.calls.filter((call) => call.operation === "deleteOne")).toHaveLength(0);
  });

  it("never creates a missing grant for an already completed challenge", async () => {
    publishCompleted();
    await expectCode(issue({ challenge: challenges.current }), "OTP_VERIFICATION_INVALID");
    expect(grants.documents).toHaveLength(0);
    expect(challenges.current.status).toBe("completed");
  });

  it("never replaces a consumed grant during replay", async () => {
    await issue();
    await consume();
    const stored = grants.snapshot();
    await expectCode(issue(), "OTP_VERIFICATION_ALREADY_USED");
    await expectCode(issue({ challenge: challenges.current }), "OTP_VERIFICATION_ALREADY_USED");
    expect(grants.snapshot()).toEqual(stored);
  });

  it("never renews expired grants, including after TTL deletion", async () => {
    await issue();
    clock.advance(570_000);
    const stored = grants.snapshot();
    await expectCode(issue(), "OTP_VERIFICATION_EXPIRED");
    await expectCode(consume(), "OTP_VERIFICATION_EXPIRED");
    expect(grants.snapshot()).toEqual(stored);
    grants.current = null;
    await expectCode(issue({ challenge: challenges.current }), "OTP_VERIFICATION_EXPIRED");
    expect(grants.documents).toHaveLength(0);
  });

  it.each([
    ["provider", { provider: "other" }],
    ["purpose", { purpose: "login" }],
    ["status", { status: "sent" }],
    ["missing approval", { approvedAt: undefined }],
    ["invalid approval", { approvedAt: new Date(NaN) }],
    ["future approval", { approvedAt: new Date("2026-08-23T12:01:00Z"), completionExpiresAt: new Date("2026-08-23T12:11:00Z") }],
    ["missing expiry", { completionExpiresAt: undefined }],
    ["extended window", { completionExpiresAt: new Date("2026-08-23T12:10:30Z") }],
    ["string expiry", { completionExpiresAt: EXPIRES_AT.toISOString() }],
    ["invalid send expiry", { expiresAt: new Date(NaN) }],
    ["missing phone", { phone: "" }],
    ["whitespace phone", { phone: ` ${PHONE}` }],
    ["invalid phone", { phone: "not-a-phone" }],
    ["non-ObjectId identity", { _id: "challenge-id" }],
    ["token hash mismatch", { challengeTokenHash: "another-hash" }],
  ])("rejects invalid challenge %s before writing", async (_name, overrides) => {
    await expectCode(issue({ challenge: makeChallenge(overrides) }), "OTP_VERIFICATION_INVALID");
    expect(grants.documents).toHaveLength(0);
    expect(challenges.current.status).toBe("approved");
  });

  it.each([undefined, null, "", "   ", 123])("rejects an invalid supplied token: %s", async (verificationToken) => {
    await expectCode(issue({ verificationToken }), "OTP_VERIFICATION_INVALID");
    expect(grants.documents).toHaveLength(0);
  });

  it("rejects expired approval before any preparation", async () => {
    clock.advance(570_000);
    await expectCode(issue(), "OTP_VERIFICATION_EXPIRED");
    expect(grants.documents).toHaveLength(0);
    expect(challenges.current.status).toBe("approved");
  });

  it.each([
    ["identity", { _id: new ObjectId() }],
    ["phone", { phone: "+972529999999" }],
    ["purpose", { purpose: "login" }],
    ["provider", { provider: "other" }],
    ["status", { status: "failed" }],
    ["approval", { approvedAt: new Date("2026-08-23T11:59:00Z"), completionExpiresAt: new Date("2026-08-23T12:09:00Z") }],
    ["send expiry", { expiresAt: new Date("2026-08-23T12:05:00Z") }],
  ])("rejects a changed durable challenge %s", async (_name, overrides) => {
    challenges.current = { ...challenge, ...overrides };
    await expectCode(issue(), "OTP_VERIFICATION_INVALID");
    expect(grants.documents).toHaveLength(0);
  });

  it.each([
    ["token", { tokenHash: "another-hash" }],
    ["completion", { completionId: new ObjectId() }],
    ["phone", { phone: "+972529999999" }],
    ["purpose", { purpose: "login" }],
    ["createdAt", { createdAt: new Date("2026-08-23T11:59:31Z") }],
    ["expiry", { expiresAt: new Date("2026-08-23T12:09:31Z") }],
    ["state", { status: "invalid" }],
    ["usedAt residue", { usedAt: APPROVED_AT }],
    ["appointment residue", { appointmentId: "another-appointment" }],
  ])("preserves and rejects an existing nonexact grant: %s", async (_name, overrides) => {
    await grants.insertOne(preparedGrant(overrides));
    const stored = grants.snapshot();
    await expectCode(issue(), "OTP_VERIFICATION_INVALID");
    expect(grants.snapshot()).toEqual(stored);
    expect(challenges.current.status).toBe("approved");
  });

  it("resumes an exact prepared grant without changing its identity", async () => {
    await grants.insertOne(preparedGrant());
    const stored = grants.snapshot();
    await expectCode(consume(), "OTP_VERIFICATION_INVALID");
    await expect(issue()).resolves.toEqual({ verificationToken: TOKEN });
    expect(grants.snapshot()).toEqual(stored);
    await expect(consume()).resolves.toMatchObject({ used: true });
  });

  it("leaves approval retryable when preparation fails before writing", async () => {
    grants.failNextPrepareWith = new Error("prepare before write");
    await expect(issue()).rejects.toThrow("prepare before write");
    expect(grants.documents).toHaveLength(0);
    expect(challenges.current.status).toBe("approved");
    await expect(issue()).resolves.toEqual({ verificationToken: TOKEN });
  });

  it("does not delete a prepared grant after lost preparation acknowledgement", async () => {
    const update = grants.updateOne.bind(grants);
    vi.spyOn(grants, "updateOne").mockImplementationOnce(async (...args) => {
      await update(...args);
      throw new Error("prepare after write");
    });
    await expect(issue()).rejects.toThrow("prepare after write");
    expect(challenges.current.status).toBe("approved");
    expect(grants.documents).toHaveLength(mode === "standalone" ? 1 : 0);
    if (mode === "standalone") await expectCode(consume(), "OTP_VERIFICATION_INVALID");
    await expect(issue()).resolves.toEqual({ verificationToken: TOKEN });
    expect(grants.documents).toHaveLength(1);
    expect(grants.calls.filter((call) => call.operation === "deleteOne")).toHaveLength(0);
  });

  it("preserves retryability when publication fails before writing", async () => {
    vi.spyOn(challengeStore, "transition").mockRejectedValueOnce(new Error("publish before write"));
    await expect(issue()).rejects.toThrow("publish before write");
    expect(challenges.current.status).toBe("approved");
    expect(grants.documents).toHaveLength(mode === "standalone" ? 1 : 0);
    if (mode === "standalone") await expectCode(consume(), "OTP_VERIFICATION_INVALID");
    await expect(issue()).resolves.toEqual({ verificationToken: TOKEN });
  });

  it("trusts only durable state after lost publication acknowledgement", async () => {
    const transition = challengeStore.transition.bind(challengeStore);
    vi.spyOn(challengeStore, "transition").mockImplementationOnce(async (...args) => {
      await transition(...args);
      throw new Error("publish after write");
    });
    if (mode === "standalone") {
      await expect(issue()).resolves.toEqual({ verificationToken: TOKEN });
      await expect(consume()).resolves.toMatchObject({ used: true });
    } else {
      await expect(issue()).rejects.toThrow("publish after write");
      expect(challenges.current.status).toBe("approved");
      expect(grants.documents).toHaveLength(0);
      await expect(issue()).resolves.toEqual({ verificationToken: TOKEN });
    }
  });

  it("rechecks approval expiry after preparation and before publication", async () => {
    const update = grants.updateOne.bind(grants);
    vi.spyOn(grants, "updateOne").mockImplementationOnce(async (...args) => {
      const result = await update(...args);
      clock.advance(570_000);
      return result;
    });
    await expectCode(issue(), "OTP_VERIFICATION_EXPIRED");
    expect(challenges.current.status).toBe("approved");
    expect(grants.documents).toHaveLength(mode === "standalone" ? 1 : 0);
  });

  it("rejects a challenge changed between preparation and publication", async () => {
    const transition = challengeStore.transition.bind(challengeStore);
    vi.spyOn(challengeStore, "transition").mockImplementationOnce(async (args, options) => {
      await challenges.updateOne({ _id: challenge._id }, { $set: { phone: "+972529999999" } }, options);
      return transition(args, options);
    });
    await expectCode(issue(), "OTP_VERIFICATION_INVALID");
    expect(challenges.current.status).toBe("approved");
  });

  it.each([
    ["phone", { phone: "+972529999999" }],
    ["purpose", { purpose: "login" }],
    ["provider", { provider: "other" }],
    ["completion", { completionId: new ObjectId() }],
    ["token hash", { bookingGrantTokenHash: "another-hash" }],
    ["state", { status: "approved" }],
  ])("requires exact completed challenge linkage for consumption and release: %s", async (_name, overrides) => {
    await issue();
    challenges.current = { ...challenges.current, ...overrides };
    await expectCode(consume(), "OTP_VERIFICATION_INVALID");
    grants.current = { ...grants.current, used: true, usedAt: clock.now(), appointmentId: "appointment-a" };
    await release();
    expect(grants.current.used).toBe(true);
  });

  it("rejects wrong phone, missing token and unknown token without consuming", async () => {
    await issue();
    await expectCode(consume({ phone: "+972529999999" }), "OTP_VERIFICATION_INVALID");
    await expectCode(consume({ verificationToken: undefined }), "OTP_VERIFICATION_REQUIRED");
    await expectCode(consume({ verificationToken: "unknown" }), "OTP_VERIFICATION_INVALID");
    expect(grants.current.used).toBe(false);
  });

  it("allows only one concurrent consumer", async () => {
    await issue();
    const results = await Promise.allSettled(Array.from({ length: 12 }, (_, index) => consume({ appointmentId: `appointment-${index}` })));
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    const rejected = results.filter((result) => result.status === "rejected");
    expect(rejected).toHaveLength(11);
    for (const result of rejected) expect(result.reason.code).toBe("OTP_VERIFICATION_ALREADY_USED");
  });

  it("releases only the owning appointment and allows a retry", async () => {
    await issue();
    await consume();
    await release({ appointmentId: "wrong-appointment" });
    await release({ phone: "+972529999999" });
    expect(grants.current.used).toBe(true);
    await release();
    expect(grants.current).toMatchObject({ used: false, usedAt: null, appointmentId: null });
    await expect(consume({ appointmentId: "appointment-b" })).resolves.toMatchObject({ used: true });
    await release();
    expect(grants.current.appointmentId).toBe("appointment-b");
  });

  it("uses primary majority reads and majority writes for nontransactional consume and release", async () => {
    await issue();
    grants.calls.length = 0;
    challenges.calls.length = 0;
    await consume();
    await release();
    const reads = [...grants.calls, ...challenges.calls].filter((call) => call.operation === "findOne");
    const writes = grants.calls.filter((call) => ["findOneAndUpdate", "updateOne"].includes(call.operation));
    expect(reads).toHaveLength(4);
    expect(writes).toHaveLength(2);
    for (const call of reads) {
      expect(call.options).toMatchObject({ readPreference: "primary", readConcern: { level: "majority" } });
    }
    for (const call of writes) expect(call.options).toMatchObject({ writeConcern: { w: "majority" } });
  });

  it("does not release an expired grant", async () => {
    await issue();
    await consume();
    clock.advance(570_000);
    await release();
    expect(grants.current.used).toBe(true);
  });

  it("checks fresh time after reading the linked challenge during consumption", async () => {
    await issue();
    challenges.afterNextFindOne = () => clock.advance(570_000);
    await expectCode(consume(), "OTP_VERIFICATION_EXPIRED");
    expect(grants.current.used).toBe(false);
  });

  it("uses the V2 challenge collection for the appointment backend", async () => {
    await issue();
    database.getCollection.mockImplementation(async (name) => {
      if (name !== "otpChallengesV2") throw new Error(`Unexpected collection: ${name}`);
      return challenges;
    });
    await expect(consume({}, { grants, clock })).resolves.toMatchObject({ used: true });
  });

  if (mode === "transaction") {
    it("retries a transaction callback without changing grant identity or lifetime", async () => {
      client.callbackRetries = 1;
      client.onCallbackRetry = () => clock.advance(60_000);
      await expect(issue()).resolves.toEqual({ verificationToken: TOKEN });
      expect(client.callbackAttempts).toBe(2);
      expect(grants.documents).toHaveLength(1);
      expect(grants.current).toMatchObject(preparedGrant());
    });

    it("does not fall back after an ordinary transaction failure", async () => {
      client.failCommitWith = new Error("commit rejected");
      await expect(issue()).rejects.toThrow("commit rejected");
      expect(challenges.current.status).toBe("approved");
      expect(grants.documents).toHaveLength(0);
      client.failCommitWith = null;
      await expect(issue()).resolves.toEqual({ verificationToken: TOKEN });
    });

    it("recovers unknown commit by reading the exact durable challenge and grant", async () => {
      client.ambiguousCommitWith = new Error("commit acknowledgement lost");
      client.endSessionError = new Error("cleanup also failed");
      await expect(issue()).resolves.toEqual({ verificationToken: TOKEN });
      expect(client.commitAttempts).toBe(1);
      expect(grants.documents).toHaveLength(1);
      await expect(consume()).resolves.toMatchObject({ used: true });
    });

    it.each(["used", "expired", "mismatched", "missing"])("never recovers unknown commit with a %s grant", async (state) => {
      client.ambiguousCommitWith = new Error("commit acknowledgement lost");
      client.afterAmbiguousCommit = async () => {
        if (state === "used") await consume();
        if (state === "expired") clock.advance(570_000);
        if (state === "mismatched") grants.current = { ...grants.current, phone: "+972529999999" };
        if (state === "missing") grants.current = null;
      };
      await expectCode(issue(), state === "used" ? "OTP_VERIFICATION_ALREADY_USED" : state === "expired" ? "OTP_VERIFICATION_EXPIRED" : "OTP_VERIFICATION_INVALID");
      expect(client.commitAttempts).toBe(1);
      expect(challenges.current.status).toBe("completed");
    });

    it("does not return a token after the window elapses during session cleanup", async () => {
      const startSession = client.startSession.bind(client);
      vi.spyOn(client, "startSession").mockImplementation(() => {
        const session = startSession();
        session.endSession = async () => clock.advance(570_000);
        return session;
      });
      await expectCode(issue(), "OTP_VERIFICATION_EXPIRED");
      expect(grants.current.expiresAt).toEqual(EXPIRES_AT);
    });

    it("passes appointment transaction sessions through consumption and release", async () => {
      await issue();
      await client.startSession().withTransaction(async () => {
        const session = client.activeSession;
        await consume({ session });
        expect(grants.current.used).toBe(false);
        await release({ session });
        await consume({ session, appointmentId: "appointment-b" });
      });
      expect(grants.current).toMatchObject({ used: true, appointmentId: "appointment-b" });
    });

    it("recovers concurrent transaction issuers without creating duplicate grants", async () => {
      const results = await Promise.allSettled(Array.from({ length: 8 }, () => issue()));
      expect(results).toEqual(Array.from({ length: 8 }, () => ({
        status: "fulfilled", value: { verificationToken: TOKEN },
      })));
      expect(grants.documents).toHaveLength(1);
      expect(grants.current).toMatchObject(preparedGrant());
    });
  }

  if (mode === "standalone") {
    it("issues one immutable grant to concurrent completion requests", async () => {
      const results = await Promise.all(Array.from({ length: 12 }, () => issue()));
      expect(results).toEqual(Array.from({ length: 12 }, () => ({ verificationToken: TOKEN })));
      expect(grants.documents).toHaveLength(1);
      expect(grants.current).toMatchObject(preparedGrant());
    });

    it("never replaces the winner when concurrent issuers supply different tokens", async () => {
      const results = await Promise.allSettled([issue(), issue({ verificationToken: "different-secret-token" })]);
      const winner = results.find((result) => result.status === "fulfilled");
      expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
      expect(results.find((result) => result.status === "rejected").reason.code).toBe("OTP_VERIFICATION_INVALID");
      expect(grants.documents).toHaveLength(1);
      expect(grants.current.tokenHash).toBe(hashBearerToken(winner.value.verificationToken));
      expect(challenges.current.bookingGrantTokenHash).toBe(grants.current.tokenHash);
    });

    it("recovers another request's exact durable result after this request's preparation failure", async () => {
      vi.spyOn(grants, "updateOne").mockImplementationOnce(async () => {
        await issue();
        throw new Error("losing request write failed");
      });
      await expect(issue()).resolves.toEqual({ verificationToken: TOKEN });
      expect(grants.documents).toHaveLength(1);
      expect(grants.current.used).toBe(false);
    });

    it("keeps prepared grants unusable while another request publishes", async () => {
      const paused = deferred();
      const resume = deferred();
      const transition = challengeStore.transition.bind(challengeStore);
      vi.spyOn(challengeStore, "transition").mockImplementationOnce(async (...args) => {
        paused.resolve();
        await resume.promise;
        return transition(...args);
      });
      const issuance = issue();
      await paused.promise;
      try {
        await expectCode(consume(), "OTP_VERIFICATION_INVALID");
        await expect(issue()).resolves.toEqual({ verificationToken: TOKEN });
        await consume();
      } finally {
        resume.resolve();
      }
      await expectCode(issuance, "OTP_VERIFICATION_ALREADY_USED");
      expect(grants.documents).toHaveLength(1);
      expect(grants.current.used).toBe(true);
    });

    it("does not return a token consumed before its publication response was recovered", async () => {
      const transition = challengeStore.transition.bind(challengeStore);
      vi.spyOn(challengeStore, "transition").mockImplementationOnce(async (...args) => {
        await transition(...args);
        await consume();
        throw new Error("publication acknowledgement lost");
      });
      await expectCode(issue(), "OTP_VERIFICATION_ALREADY_USED");
      expect(grants.current.used).toBe(true);
    });
  }
});

describe("booking grant errors", () => {
  it("preserves the exported error contract", () => {
    expect(new OtpVerificationGrantError("OTP_COMPLETION_IN_PROGRESS")).toMatchObject({
      name: "OtpVerificationGrantError", code: "OTP_COMPLETION_IN_PROGRESS", status: 409,
    });
    expect(new OtpVerificationGrantError("OTP_VERIFICATION_INVALID").status).toBe(401);
  });

  it("recognizes only the canonical standalone transaction error", () => {
    const canonical = Object.assign(new Error(UNSUPPORTED_MESSAGE), { code: 20, codeName: "IllegalOperation" });
    expect(isTransactionUnsupportedError(canonical)).toBe(true);
    expect(isTransactionUnsupportedError({ cause: canonical })).toBe(true);
    expect(isTransactionUnsupportedError(new Error(UNSUPPORTED_MESSAGE))).toBe(false);
    expect(isTransactionUnsupportedError({ code: 20, codeName: "IllegalOperation", message: "different failure" })).toBe(false);
  });
});
