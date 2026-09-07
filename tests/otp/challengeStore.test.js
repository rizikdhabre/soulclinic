import { beforeEach, describe, expect, it } from "vitest";
import { createOtpChallengeStore } from "@/lib/otp/challengeStore";
import {
  createTestClock,
  MemoryMongoCollection,
} from "../helpers/memoryOtpStores";

function completingChallenge(overrides = {}) {
  return {
    _id: "challenge-server-time",
    phone: "phone-server-time",
    purpose: "booking",
    challengeTokenHash: "hash-server-time",
    provider: "firebase",
    status: "completing",
    completionId: "completion-server-time",
    completionPreviousStatus: "pending",
    completionLeaseExpiresAt: new Date("2026-08-23T12:00:30.000Z"),
    bookingGrantTokenHash: "grant-hash-server-time",
    createdAt: new Date("2026-08-23T11:59:00.000Z"),
    updatedAt: new Date("2026-08-23T12:00:00.000Z"),
    expiresAt: new Date("2026-08-23T12:10:00.000Z"),
    ...overrides,
  };
}

describe("completion lease server-time fencing", () => {
  let clock;
  let collection;
  let store;

  beforeEach(() => {
    clock = createTestClock("2026-08-23T12:00:31.000Z");
    collection = new MemoryMongoCollection([completingChallenge()]);
    collection.serverClock = clock;
    store = createOtpChallengeStore({ collection });
  });

  it("rejects a stale finalizer using Mongo server time", async () => {
    const capturedBeforeExpiry = new Date("2026-08-23T12:00:00.000Z");

    await expect(
      store.finalizeCompletionLease({
        challengeId: "challenge-server-time",
        challengeTokenHash: "hash-server-time",
        completionId: "completion-server-time",
        bookingGrantTokenHash: "grant-hash-server-time",
        now: capturedBeforeExpiry,
      }),
    ).resolves.toBeNull();

    expect(collection.current.status).toBe("completing");
    expect(collection.calls.at(-1).filter).toMatchObject({
      status: "completing",
      completionId: "completion-server-time",
      $expr: {
        $gt: ["$completionLeaseExpiresAt", "$$NOW"],
      },
    });
  });

  it("claims an expired lease using Mongo server time before cleanup", async () => {
    const capturedBeforeExpiry = new Date("2026-08-23T12:00:00.000Z");

    const restored = await store.restoreCompletionLease({
      challengeId: "challenge-server-time",
      challengeTokenHash: "hash-server-time",
      completionId: "completion-server-time",
      bookingGrantTokenHash: "grant-hash-server-time",
      previousStatus: "pending",
      now: capturedBeforeExpiry,
      expiredOnly: true,
    });

    expect(restored).toMatchObject({ status: "pending" });
    expect(restored).not.toHaveProperty("completionId");
    expect(collection.calls.at(-1).filter).toMatchObject({
      status: "completing",
      completionId: "completion-server-time",
      $expr: {
        $lte: ["$completionLeaseExpiresAt", "$$NOW"],
      },
    });
  });

  it("does not claim a lease that Mongo server time says is still active", async () => {
    clock = createTestClock("2026-08-23T12:00:29.000Z");
    collection.serverClock = clock;
    const capturedAfterExpiry = new Date("2026-08-23T12:01:00.000Z");

    await expect(
      store.restoreCompletionLease({
        challengeId: "challenge-server-time",
        challengeTokenHash: "hash-server-time",
        completionId: "completion-server-time",
        bookingGrantTokenHash: "grant-hash-server-time",
        previousStatus: "pending",
        now: capturedAfterExpiry,
        expiredOnly: true,
      }),
    ).resolves.toBeNull();
    expect(collection.current.status).toBe("completing");
  });
});

it("rotates correlation and cooldown metadata without carrying them into legacy rotations", async () => {
  const collection = new MemoryMongoCollection();
  const store = createOtpChallengeStore({ collection });
  const input = {
    phone: "+972521234567", purpose: "booking", provider: "firebase",
    challengeTokenHash: "first", now: new Date("2026-08-23T12:00:00.000Z"),
    expiresAt: new Date("2026-08-23T12:10:00.000Z"),
  };
  const correlationId = "061a1297-e394-40a2-9e22-fc63b2c186a1";
  const retryAt = new Date("2026-08-23T12:01:00.000Z");
  await expect(store.rotate({ ...input, correlationId, retryAt })).resolves.toMatchObject({ correlationId, retryAt });
  const legacy = await store.rotate({ ...input, challengeTokenHash: "second" });
  expect(legacy).not.toHaveProperty("correlationId");
  expect(legacy).not.toHaveProperty("retryAt");
});
