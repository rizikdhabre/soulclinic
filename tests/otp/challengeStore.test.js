import { beforeEach, describe, expect, it, vi } from "vitest";
import { ObjectId } from "mongodb";
import { createOtpChallengeStore, OTP_CHALLENGE_COLLECTION } from "@/lib/otp/challengeStore";
import { hashBearerToken } from "@/lib/otp/crypto";
import { createTestClock, MemoryMongoCollection } from "../helpers/memoryOtpStores";

describe("immutable Twilio challenge storage", () => {
  let clock;
  let collection;
  let store;
  let input;

  beforeEach(() => {
    clock = createTestClock();
    collection = new MemoryMongoCollection();
    store = createOtpChallengeStore({ collection });
    input = {
      phone: "+972521234567", purpose: "booking", sourceHash: "source-hash",
      challengeTokenHash: hashBearerToken("a".repeat(43)),
      now: clock.now(), expiresAt: new Date(+clock.now() + 600_000),
      retryAt: new Date(+clock.now() + 60_000),
      correlationId: "061a1297-e394-40a2-9e22-fc63b2c186a1",
    };
  });

  it("uses a unique bearer hash, nonunique phone/purpose, and a separate retention TTL", async () => {
    expect(OTP_CHALLENGE_COLLECTION).toBe("otpChallengesV2");
    await store.ensureIndexes();
    await store.ensureIndexes();
    expect(collection.indexes).toEqual([
      { keys: { challengeTokenHash: 1 }, options: { unique: true, name: "otp_v2_token" } },
      { keys: { phone: 1, purpose: 1 }, options: { name: "otp_v2_phone_purpose" } },
      { keys: { purgeAt: 1 }, options: { expireAfterSeconds: 0, name: "otp_v2_retention" } },
    ]);
  });

  it("retries failed index initialization before a later create", async () => {
    const createIndex = vi.spyOn(collection, "createIndex").mockRejectedValueOnce(new Error("index unavailable"));
    await expect(store.create(input)).rejects.toThrow("index unavailable");
    expect(collection.documents).toEqual([]);
    await expect(store.create(input)).resolves.toMatchObject({ status: "prepared" });
    expect(createIndex).toHaveBeenCalledTimes(6);
  });

  it("inserts a complete prepared record with majority durability and no caller payload", async () => {
    const created = await store.create({ ...input, challengeToken: "plaintext", code: "654321", profile: { firstName: "Private" } });
    expect(created).toEqual({
      _id: expect.any(ObjectId), phone: input.phone, purpose: input.purpose,
      challengeTokenHash: input.challengeTokenHash, sourceHash: input.sourceHash,
      provider: "twilio", status: "prepared", correlationId: input.correlationId,
      retryAt: input.retryAt, createdAt: input.now, updatedAt: input.now,
      expiresAt: input.expiresAt, purgeAt: new Date(+input.now + 7_200_000),
    });
    expect(collection.calls.at(-1)).toEqual({
      operation: "insertOne", document: created, options: { writeConcern: { w: "majority" } },
    });
  });

  it("creates new identities without rotating or extending an earlier approval", async () => {
    const first = await store.create(input);
    await store.transition({
      challengeTokenHash: input.challengeTokenHash, from: "prepared", now: clock.now(),
      patch: { status: "approved", approvedAt: clock.now(), verificationSid: `VE${"a".repeat(32)}` },
    });
    const original = await store.findByTokenHash(input.challengeTokenHash);
    clock.advance(60_000);
    const second = await store.create({
      ...input, challengeTokenHash: hashBearerToken("b".repeat(43)), now: clock.now(),
      expiresAt: new Date(+clock.now() + 600_000), retryAt: new Date(+clock.now() + 60_000),
      correlationId: "061a1297-e394-40a2-9e22-fc63b2c186a2",
    });
    expect(second._id.equals(first._id)).toBe(false);
    expect(second.status).toBe("prepared");
    expect(second).not.toHaveProperty("approvedAt");
    expect(second).not.toHaveProperty("verificationSid");
    expect(collection.documents).toHaveLength(2);
    expect(await store.findByTokenHash(input.challengeTokenHash)).toEqual(original);
  });

  it("rejects a duplicate hash instead of replacing the original challenge", async () => {
    const original = await store.create(input);
    await expect(store.create({ ...input, phone: "+972521234568", purpose: "login" })).rejects.toMatchObject({ code: 11000 });
    expect(collection.documents).toEqual([original]);
  });

  it("uses primary majority reads and passes an explicit transaction session unchanged", async () => {
    await store.create(input);
    await expect(store.findByTokenHash(input.challengeTokenHash)).resolves.toHaveProperty("phone", input.phone);
    expect(collection.calls.at(-1)).toMatchObject({
      filter: { challengeTokenHash: input.challengeTokenHash },
      options: { readPreference: "primary", readConcern: { level: "majority" } },
    });
    const session = { id: "transaction-session" };
    await expect(store.findByTokenHash("missing", { session })).resolves.toBeNull();
    expect(collection.calls.at(-1).options).toEqual({ session });
  });

  it.each([0, 1])("fences expiry at the exact deadline plus %s ms without relying on TTL deletion", async (lateBy) => {
    await store.create(input);
    clock.advance(600_000 + lateBy);
    await expect(store.transition({
      challengeTokenHash: input.challengeTokenHash, from: "prepared", now: clock.now(),
      match: { expiresAt: { $gt: clock.now() } }, patch: { status: "sending" },
    })).resolves.toBeNull();
    expect(collection.current.status).toBe("prepared");
    expect(await store.findByTokenHash(input.challengeTokenHash)).not.toBeNull();
  });

  it("conditionally transitions only the matching token, state, purpose and attempt", async () => {
    await store.create(input);
    const transition = {
      challengeTokenHash: input.challengeTokenHash, from: ["prepared", "sent"], now: clock.now(),
      match: { purpose: "booking", expiresAt: { $gt: clock.now() } },
      patch: { status: "sending", sendAttemptId: "attempt-one" },
    };
    await expect(store.transition({ ...transition, challengeTokenHash: "wrong-hash" })).resolves.toBeNull();
    await expect(store.transition({ ...transition, match: { purpose: "login" } })).resolves.toBeNull();
    await expect(store.transition(transition)).resolves.toMatchObject({ status: "sending" });
    expect(collection.calls.at(-1)).toMatchObject({
      filter: { ...transition.match, challengeTokenHash: input.challengeTokenHash, provider: "twilio", status: { $in: ["prepared", "sent"] } },
      update: { $set: { ...transition.patch, updatedAt: clock.now() } },
      options: { writeConcern: { w: "majority" }, returnDocument: "after" },
    });
    await expect(store.transition(transition)).resolves.toBeNull();
    await expect(store.transition({
      ...transition, from: "sending", match: { sendAttemptId: "stale-attempt" }, patch: { status: "sent" },
    })).resolves.toBeNull();
    expect(collection.current).toMatchObject({
      phone: input.phone, purpose: input.purpose, sourceHash: input.sourceHash,
      expiresAt: input.expiresAt, createdAt: input.now, status: "sending", sendAttemptId: "attempt-one",
    });
  });

  it("does not let extra match keys override the token, provider or expected state", async () => {
    await store.create(input);
    await expect(store.transition({
      challengeTokenHash: "wrong-hash", from: "sent", now: clock.now(),
      match: { challengeTokenHash: input.challengeTokenHash, status: "prepared", provider: "twilio" },
      patch: { status: "completed" },
    })).resolves.toBeNull();
    expect(collection.current.status).toBe("prepared");
  });

  it("omits standalone write concern inside a supplied transaction", async () => {
    await store.create(input);
    const session = { id: "transaction-session" };
    await store.transition({
      challengeTokenHash: input.challengeTokenHash, from: "prepared", now: clock.now(), patch: { status: "sending" },
    }, { session });
    expect(collection.calls.at(-1).options).toEqual({ session, returnDocument: "after" });
  });
});
