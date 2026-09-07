import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  createOtpChallengeStore,
} from "@/lib/otp/challengeStore";
import { createOtpChallengeService } from "@/lib/otp/challengeService";
import { hashBearerToken } from "@/lib/otp/crypto";
import { createOtpRateLimitStore } from "@/lib/otp/rateLimitStore";
import { OtpError } from "@/lib/otp/errors";
import { createTestClock, MemoryVersionedCollection } from "../helpers/memoryOtpStores";

const phone = "+972521234567";

function clone(value) {
  return value === undefined ? undefined : structuredClone(value);
}

function matches(document, filter, serverNow) {
  return Object.entries(filter).every(([key, expected]) => {
    if (key === "$expr") {
      const [[operator, operands]] = Object.entries(expected);
      const [field, right] = operands;
      const left = document[field.slice(1)];
      const resolvedRight = right === "$$NOW" ? serverNow : right;
      if (operator === "$gt") return left > resolvedRight;
      if (operator === "$lte") return left <= resolvedRight;
      return false;
    }
    if (expected && typeof expected === "object" && !(expected instanceof Date)) {
      if (Object.hasOwn(expected, "$gt")) return document[key] > expected.$gt;
      if (Object.hasOwn(expected, "$lte")) return document[key] <= expected.$lte;
    }
    return document[key] === expected;
  });
}

function applyUpdate(document, update) {
  const next = { ...document, ...clone(update.$set ?? {}) };
  for (const key of Object.keys(update.$unset ?? {})) delete next[key];
  return next;
}

class MemoryChallengeCollection {
  constructor() {
    this.documents = [];
    this.indexes = [];
    this.calls = [];
    this.nextId = 1;
    this.serverNow = new Date();
  }

  async createIndex(keys, options = {}) {
    this.indexes.push({ keys: clone(keys), options: clone(options) });
    return options.name;
  }

  async findOne(filter, options = {}) {
    this.calls.push({ method: "findOne", filter: clone(filter), options });
    return clone(
      this.documents.find((document) =>
        matches(document, filter, this.serverNow),
      ) ?? null,
    );
  }

  async findOneAndUpdate(filter, update, options = {}) {
    this.calls.push({
      method: "findOneAndUpdate",
      filter: clone(filter),
      update: clone(update),
      options,
    });
    const index = this.documents.findIndex((document) =>
      matches(document, filter, this.serverNow),
    );

    if (index === -1) {
      if (!options.upsert) return null;
      const inserted = applyUpdate({ _id: this.nextId }, update);
      this.nextId += 1;
      this.documents.push(inserted);
      return clone(inserted);
    }

    this.documents[index] = applyUpdate(this.documents[index], update);
    return clone(this.documents[index]);
  }
}

function activeChallenge(overrides = {}) {
  return {
    _id: 1,
    phone,
    purpose: "booking",
    challengeTokenHash: "hash-current",
    provider: "firebase",
    status: "pending",
    fallbackUsed: false,
    providerAttemptCount: 0,
    lastProviderStatus: null,
    lastProviderErrorCode: null,
    createdAt: new Date("2026-08-23T12:00:00.000Z"),
    updatedAt: new Date("2026-08-23T12:00:00.000Z"),
    expiresAt: new Date("2026-08-23T12:10:00.000Z"),
    ...overrides,
  };
}

describe("createOtpChallengeStore", () => {
  let collection;
  let store;
  const now = new Date("2026-08-23T12:01:00.000Z");

  beforeEach(() => {
    collection = new MemoryChallengeCollection();
    collection.serverNow = now;
    store = createOtpChallengeStore({ collection });
  });

  async function expectRejectedBeforeMutation(operation) {
    const callCount = collection.calls.length;
    await expect(operation()).rejects.toThrow(TypeError);
    expect(collection.calls).toHaveLength(callCount);
  }

  it("creates exact unique and absolute TTL indexes", async () => {
    await store.ensureIndexes();

    expect(collection.indexes).toEqual([
      {
        keys: { phone: 1, purpose: 1 },
        options: { unique: true, name: "otp_challenge_phone_purpose" },
      },
      {
        keys: { challengeTokenHash: 1 },
        options: { unique: true, name: "otp_challenge_token_hash" },
      },
      {
        keys: { expiresAt: 1 },
        options: { expireAfterSeconds: 0, name: "otp_challenge_expires_ttl" },
      },
    ]);
  });

  it("rotates any prior state into one complete fresh document", async () => {
    collection.documents.push(
      activeChallenge({
        status: "completed",
        fallbackReservedAt: new Date(0),
        lastFirebaseErrorCode: "auth/internal-error",
        twilioSentAt: new Date(0),
        providerFinishedAt: new Date(0),
        completedAt: new Date(0),
        completionId: "old-completion",
        completionLeaseExpiresAt: new Date(0),
        completionPreviousStatus: "pending",
        bookingGrantTokenHash: "old-grant-hash",
      }),
    );
    const expiresAt = new Date("2026-08-23T12:11:00.000Z");

    const result = await store.rotate({
      phone,
      purpose: "booking",
      challengeTokenHash: "hash-next",
      provider: "development",
      now,
      expiresAt,
    });

    expect(result).toEqual({
      _id: 1,
      phone,
      purpose: "booking",
      challengeTokenHash: "hash-next",
      provider: "development",
      status: "pending",
      fallbackUsed: false,
      providerAttemptCount: 0,
      lastProviderStatus: null,
      lastProviderErrorCode: null,
      createdAt: now,
      updatedAt: now,
      expiresAt,
    });
    expect(collection.documents).toHaveLength(1);
    expect(collection.calls.at(-1)).toMatchObject({
      filter: { phone, purpose: "booking" },
      options: { upsert: true, returnDocument: "after" },
    });
  });

  it("forwards a session and exposes plain token-hash lookup results", async () => {
    collection.documents.push(activeChallenge());
    const session = { id: "session-a" };

    await expect(
      store.findByTokenHash("hash-current", { session }),
    ).resolves.toMatchObject({ _id: 1, phone });
    await expect(store.findByTokenHash("missing")).resolves.toBeNull();
    expect(collection.calls[0]).toEqual({
      method: "findOne",
      filter: { challengeTokenHash: "hash-current" },
      options: { session },
    });
  });

  it("reserves fallback once with the exact active Firebase filter", async () => {
    collection.documents.push(activeChallenge());

    const result = await store.reserveFallback({
      challengeId: 1,
      challengeTokenHash: "hash-current",
      firebaseErrorCode: "auth/internal-error",
      now,
    });

    expect(result).toMatchObject({
      provider: "twilio",
      status: "twilio_sending",
      fallbackUsed: true,
      fallbackReservedAt: now,
      lastFirebaseErrorCode: "auth/internal-error",
      providerAttemptCount: 0,
      lastProviderStatus: null,
      lastProviderErrorCode: null,
      updatedAt: now,
    });
    expect(collection.calls.at(-1).filter).toEqual({
      _id: 1,
      challengeTokenHash: "hash-current",
      provider: "firebase",
      status: "pending",
      fallbackUsed: false,
      expiresAt: { $gt: now },
    });
    await expect(
      store.reserveFallback({
        challengeId: 1,
        challengeTokenHash: "hash-current",
        firebaseErrorCode: "auth/internal-error",
        now,
      }),
    ).resolves.toBeNull();
  });

  it("marks only the reserved unexpired Twilio send as sent", async () => {
    collection.documents.push(
      activeChallenge({ provider: "twilio", status: "twilio_sending", fallbackUsed: true }),
    );

    const result = await store.markTwilioSent({
      challengeId: 1,
      challengeTokenHash: "hash-current",
      providerAttemptCount: 2,
      lastProviderStatus: "pending",
      now,
    });

    expect(result).toMatchObject({
      status: "twilio_sent",
      providerAttemptCount: 2,
      lastProviderStatus: "pending",
      lastProviderErrorCode: null,
      twilioSentAt: now,
      updatedAt: now,
    });
    expect(collection.calls.at(-1).filter).toEqual({
      _id: 1,
      challengeTokenHash: "hash-current",
      provider: "twilio",
      status: "twilio_sending",
      fallbackUsed: true,
      expiresAt: { $gt: now },
    });
  });

  it.each(["failed", "delivery_unknown"])(
    "stores bounded Twilio summaries for %s",
    async (status) => {
      collection.documents.push(
        activeChallenge({ provider: "twilio", status: "twilio_sending", fallbackUsed: true }),
      );

      const result = await store.markTwilioFailure({
        challengeId: 1,
        challengeTokenHash: "hash-current",
        status,
        providerAttemptCount: 1,
        lastProviderStatus: "failed",
        lastProviderErrorCode: "provider-temporary",
        now,
      });

      expect(result).toMatchObject({
        status,
        providerAttemptCount: 1,
        lastProviderStatus: "failed",
        lastProviderErrorCode: "provider-temporary",
        providerFinishedAt: now,
        updatedAt: now,
      });
      expect(JSON.stringify(result)).not.toContain("provider raw body");
    },
  );

  it("rejects an unbounded Twilio failure status before mutation", async () => {
    collection.documents.push(
      activeChallenge({ provider: "twilio", status: "twilio_sending", fallbackUsed: true }),
    );

    await expect(
      store.markTwilioFailure({
        challengeId: 1,
        challengeTokenHash: "hash-current",
        status: "pending",
        providerAttemptCount: 1,
        lastProviderStatus: "failed",
        lastProviderErrorCode: "provider-temporary",
        now,
      }),
    ).rejects.toThrow(TypeError);
    expect(collection.calls).toHaveLength(0);
  });

  it.each([
    ["sent", -1],
    ["sent", 4],
    ["sent", 1.5],
    ["sent", "1"],
    ["failure", -1],
    ["failure", 4],
    ["failure", 1.5],
    ["failure", null],
  ])("rejects %s attempt count %j before mutation", async (transition, count) => {
    collection.documents.push(
      activeChallenge({ provider: "twilio", status: "twilio_sending", fallbackUsed: true }),
    );

    await expectRejectedBeforeMutation(() =>
      transition === "sent"
        ? store.markTwilioSent({
            challengeId: 1,
            challengeTokenHash: "hash-current",
            providerAttemptCount: count,
            lastProviderStatus: "pending",
            now,
          })
        : store.markTwilioFailure({
            challengeId: 1,
            challengeTokenHash: "hash-current",
            status: "failed",
            providerAttemptCount: count,
            lastProviderStatus: "failed",
            lastProviderErrorCode: "ETIMEDOUT",
            now,
          }),
    );
  });

  it.each([
    ["fallback", "lastFirebaseErrorCode", { message: "raw provider object" }],
    ["fallback", "lastFirebaseErrorCode", ["auth/internal-error"]],
    ["fallback", "lastFirebaseErrorCode", "auth internal error"],
    ["fallback", "lastFirebaseErrorCode", " auth/internal-error"],
    ["fallback", "lastFirebaseErrorCode", "x".repeat(65)],
    ["sent", "lastProviderStatus", { status: "pending" }],
    ["sent", "lastProviderStatus", ["pending"]],
    ["sent", "lastProviderStatus", "provider raw message"],
    ["sent", "lastProviderStatus", ""],
    ["sent", "lastProviderStatus", "-pending"],
    ["sent", "lastProviderStatus", "x".repeat(65)],
    ["failure", "lastProviderStatus", { status: "failed" }],
    ["failure", "lastProviderStatus", "provider raw status"],
    ["failure", "lastProviderErrorCode", new Error("raw exception")],
    ["failure", "lastProviderErrorCode", ["ETIMEDOUT"]],
    ["failure", "lastProviderErrorCode", "socket hang up"],
    ["failure", "lastProviderErrorCode", "x".repeat(65)],
  ])(
    "rejects unsafe %s %s value before mutation",
    async (transition, field, unsafeValue) => {
      collection.documents.push(
        activeChallenge({
          provider: transition === "fallback" ? "firebase" : "twilio",
          status: transition === "fallback" ? "pending" : "twilio_sending",
          fallbackUsed: transition !== "fallback",
        }),
      );

      await expectRejectedBeforeMutation(() => {
        if (transition === "fallback") {
          return store.reserveFallback({
            challengeId: 1,
            challengeTokenHash: "hash-current",
            firebaseErrorCode: unsafeValue,
            now,
          });
        }
        if (transition === "sent") {
          return store.markTwilioSent({
            challengeId: 1,
            challengeTokenHash: "hash-current",
            providerAttemptCount: 1,
            lastProviderStatus: unsafeValue,
            now,
          });
        }
        return store.markTwilioFailure({
          challengeId: 1,
          challengeTokenHash: "hash-current",
          status: "failed",
          providerAttemptCount: 1,
          lastProviderStatus: field === "lastProviderStatus" ? unsafeValue : "failed",
          lastProviderErrorCode:
            field === "lastProviderErrorCode" ? unsafeValue : "ETIMEDOUT",
          now,
        });
      });
    },
  );

  it("accepts null provider summaries without widening the transition", async () => {
    collection.documents.push(
      activeChallenge({ provider: "twilio", status: "twilio_sending", fallbackUsed: true }),
    );

    const result = await store.markTwilioFailure({
      challengeId: 1,
      challengeTokenHash: "hash-current",
      status: "delivery_unknown",
      providerAttemptCount: 3,
      lastProviderStatus: null,
      lastProviderErrorCode: null,
      now,
    });

    expect(result).toMatchObject({
      status: "delivery_unknown",
      providerAttemptCount: 3,
      lastProviderStatus: null,
      lastProviderErrorCode: null,
    });
  });

  it("completes login only from the coordinator-supplied eligible status", async () => {
    collection.documents.push(
      activeChallenge({
        purpose: "login",
        completionId: "stale",
        bookingGrantTokenHash: "stale-hash",
      }),
    );

    const result = await store.completeLogin({
      challengeId: 1,
      challengeTokenHash: "hash-current",
      purpose: "login",
      provider: "firebase",
      eligibleStatus: "pending",
      now,
    });

    expect(result).toMatchObject({ status: "completed", completedAt: now, updatedAt: now });
    expect(result).not.toHaveProperty("completionId");
    expect(result).not.toHaveProperty("bookingGrantTokenHash");
    expect(collection.calls.at(-1).filter).toEqual({
      _id: 1,
      challengeTokenHash: "hash-current",
      purpose: "login",
      provider: "firebase",
      status: "pending",
      expiresAt: { $gt: now },
    });
  });

  it("loses the login CAS when the stored purpose no longer matches", async () => {
    collection.documents.push(activeChallenge({ purpose: "booking" }));

    const result = await store.completeLogin({
      challengeId: 1,
      challengeTokenHash: "hash-current",
      purpose: "login",
      provider: "firebase",
      eligibleStatus: "pending",
      now,
    });

    expect(result).toBeNull();
    expect(collection.documents[0]).toMatchObject({
      purpose: "booking",
      status: "pending",
    });
    expect(collection.calls.at(-1).filter).toEqual({
      _id: 1,
      challengeTokenHash: "hash-current",
      purpose: "login",
      provider: "firebase",
      status: "pending",
      expiresAt: { $gt: now },
    });
  });

  it("allows exactly one atomic login completion winner", async () => {
    collection.documents.push(activeChallenge({ purpose: "login" }));
    const completion = {
      challengeId: 1,
      challengeTokenHash: "hash-current",
      purpose: "login",
      provider: "firebase",
      eligibleStatus: "pending",
      now,
    };

    const results = await Promise.all([
      store.completeLogin(completion),
      store.completeLogin(completion),
    ]);

    expect(results.filter(Boolean)).toHaveLength(1);
    expect(results.filter((result) => result === null)).toHaveLength(1);
    expect(collection.documents[0]).toMatchObject({
      purpose: "login",
      status: "completed",
      completedAt: now,
    });
    const completionCalls = collection.calls.filter(
      ({ method }) => method === "findOneAndUpdate",
    );
    expect(completionCalls).toHaveLength(2);
    expect(completionCalls.map(({ filter }) => filter.purpose)).toEqual([
      "login",
      "login",
    ]);
  });

  it("completes booking transaction state while retaining its completion ID", async () => {
    collection.documents.push(
      activeChallenge({
        provider: "twilio",
        status: "twilio_sent",
        completionLeaseExpiresAt: new Date(0),
        completionPreviousStatus: "twilio_sent",
        bookingGrantTokenHash: "stale-hash",
      }),
    );

    const result = await store.completeBooking({
      challengeId: 1,
      challengeTokenHash: "hash-current",
      provider: "twilio",
      eligibleStatus: "twilio_sent",
      completionId: "completion-a",
      now,
    });

    expect(result).toMatchObject({
      status: "completed",
      completionId: "completion-a",
      completedAt: now,
      updatedAt: now,
    });
    expect(result).not.toHaveProperty("completionLeaseExpiresAt");
    expect(result).not.toHaveProperty("completionPreviousStatus");
    expect(result).not.toHaveProperty("bookingGrantTokenHash");
  });

  it("reserves and finalizes one matching completion lease", async () => {
    collection.documents.push(activeChallenge());
    const leaseExpiresAt = new Date("2026-08-23T12:01:30.000Z");

    const reserved = await store.reserveCompletionLease({
      challengeId: 1,
      challengeTokenHash: "hash-current",
      provider: "firebase",
      eligibleStatus: "pending",
      completionId: "completion-a",
      bookingGrantTokenHash: "grant-hash-a",
      now,
      leaseExpiresAt,
    });
    expect(reserved).toMatchObject({
      status: "completing",
      completionId: "completion-a",
      completionPreviousStatus: "pending",
      completionLeaseExpiresAt: leaseExpiresAt,
      bookingGrantTokenHash: "grant-hash-a",
    });

    const finalized = await store.finalizeCompletionLease({
      challengeId: 1,
      challengeTokenHash: "hash-current",
      completionId: "completion-a",
      bookingGrantTokenHash: "grant-hash-a",
      now,
    });
    expect(finalized).toMatchObject({
      status: "completed",
      completionId: "completion-a",
      completedAt: now,
    });
    expect(finalized).not.toHaveProperty("completionPreviousStatus");
    expect(finalized).not.toHaveProperty("completionLeaseExpiresAt");
    expect(finalized).not.toHaveProperty("bookingGrantTokenHash");
  });

  it("restores only the same expired completion lease", async () => {
    collection.documents.push(
      activeChallenge({
        status: "completing",
        completionId: "completion-a",
        completionPreviousStatus: "pending",
        completionLeaseExpiresAt: new Date("2026-08-23T12:00:30.000Z"),
        bookingGrantTokenHash: "grant-hash-a",
      }),
    );

    await expect(
      store.restoreCompletionLease({
        challengeId: 1,
        challengeTokenHash: "hash-current",
        completionId: "wrong-completion",
        bookingGrantTokenHash: "grant-hash-a",
        previousStatus: "pending",
        now,
        expiredOnly: true,
      }),
    ).resolves.toBeNull();

    const restored = await store.restoreCompletionLease({
      challengeId: 1,
      challengeTokenHash: "hash-current",
      completionId: "completion-a",
      bookingGrantTokenHash: "grant-hash-a",
      previousStatus: "pending",
      now,
      expiredOnly: true,
    });
    expect(restored).toMatchObject({ status: "pending", updatedAt: now });
    expect(restored).not.toHaveProperty("completionId");
    expect(collection.calls.at(-1).filter).toEqual({
      _id: 1,
      challengeTokenHash: "hash-current",
      status: "completing",
      completionId: "completion-a",
      bookingGrantTokenHash: "grant-hash-a",
      completionPreviousStatus: "pending",
      $expr: { $lte: ["$completionLeaseExpiresAt", "$$NOW"] },
    });
  });
});

describe("createOtpChallengeService", () => {
  let clock;
  let collection;
  let challengeStore;
  let rateStore;
  let deriveSourceHash;
  let tokens;

  beforeEach(() => {
    clock = createTestClock();
    collection = new MemoryChallengeCollection();
    challengeStore = createOtpChallengeStore({ collection });
    rateStore = {
      claimSourceAction: vi.fn().mockResolvedValue(undefined),
      claimPhoneStart: vi.fn().mockResolvedValue({ retryAfterSeconds: 60 }),
    };
    deriveSourceHash = vi.fn().mockReturnValue("source-hash");
    tokens = ["challenge-plaintext", "challenge-next"];
  });

  function makeService(overrides = {}) {
    return createOtpChallengeService({
      deriveSourceHash,
      rateStore,
      challengeStore,
      tokenFactory: vi.fn(() => tokens.shift()),
      hashToken: hashBearerToken,
      clock,
      env: { NODE_ENV: "test", OTP_SOURCE_HASH_SECRET: "test-secret" },
      ...overrides,
    });
  }

  it("creates a normalized booking challenge and stores only its hash", async () => {
    const request = new Request("https://example.com/api/otp/challenge");

    const result = await makeService().create({
      request,
      phone: "0521234567",
      purpose: "booking",
    });

    expect(result).toMatchObject({ provider: "firebase" });
    expect(result.challengeToken).toBe("challenge-plaintext");
    const [stored] = collection.documents;
    expect(stored).toMatchObject({
      phone,
      purpose: "booking",
      status: "pending",
      provider: "firebase",
      fallbackUsed: false,
    });
    expect(stored.challengeTokenHash).toBe(hashBearerToken("challenge-plaintext"));
    expect(JSON.stringify(stored)).not.toContain("challenge-plaintext");
  });

  it.each(["booking", "login"])("rotates one document for %s", async (purpose) => {
    const service = makeService();
    const request = new Request("https://example.com/api/otp/challenge");
    await service.create({ request, phone: "0521234567", purpose });
    clock.advance(61_000);
    await service.create({ request, phone: "0521234567", purpose });

    expect(collection.documents.filter((item) => item.purpose === purpose)).toHaveLength(1);
  });

  it("invalidates the old bearer token after rotation", async () => {
    const service = makeService();
    const request = new Request("https://example.com/api/otp/challenge");
    const first = await service.create({ request, phone: "0521234567", purpose: "booking" });
    clock.advance(61_000);
    const second = await service.create({ request, phone: "0521234567", purpose: "booking" });

    await expect(
      challengeStore.findByTokenHash(hashBearerToken(first.challengeToken)),
    ).resolves.toBeNull();
    await expect(
      challengeStore.findByTokenHash(hashBearerToken(second.challengeToken)),
    ).resolves.toMatchObject({ phone, purpose: "booking" });
  });

  it("does not expose customer existence or profile data", async () => {
    const usersCollection = { findOne: vi.fn() };
    const result = await makeService({ usersCollection }).create({
      request: new Request("https://example.com/api/otp/challenge"),
      phone: "0521234567",
      purpose: "booking",
    });

    expect(result).not.toHaveProperty("exists");
    expect(result).not.toHaveProperty("firstName");
    expect(result).not.toHaveProperty("lastName");
    expect(usersCollection.findOne).not.toHaveBeenCalled();
  });

  it("rejects an invalid phone after consuming only the source claim", async () => {
    await expect(
      makeService().create({
        request: new Request("https://example.com/api/otp/challenge"),
        phone: "not-a-phone",
        purpose: "booking",
      }),
    ).rejects.toMatchObject({ code: "INVALID_PHONE", status: 400 });
    expect(rateStore.claimSourceAction).toHaveBeenCalledWith("source-hash", "challenge");
    expect(rateStore.claimPhoneStart).not.toHaveBeenCalled();
  });

  it("rejects an invalid purpose before the phone claim", async () => {
    await expect(
      makeService().create({
        request: new Request("https://example.com/api/otp/challenge"),
        phone: "0521234567",
        purpose: "booking ",
      }),
    ).rejects.toMatchObject({ code: "INVALID_OTP_PURPOSE", status: 400 });
    expect(rateStore.claimPhoneStart).not.toHaveBeenCalled();
  });

  it("returns login purpose with an exact ten-minute expiry", async () => {
    const startedAt = clock.now();
    const result = await makeService().create({
      request: new Request("https://example.com/api/otp/challenge"),
      phone: "0521234567",
      purpose: "login",
    });

    expect(result).toEqual({
      challengeToken: "challenge-plaintext",
      provider: "firebase",
      expiresAt: new Date(startedAt.getTime() + 600_000),
      retryAfterSeconds: 60,
      retryAt: "2026-08-23T12:01:00.000Z",
      serverTime: "2026-08-23T12:00:00.000Z",
      correlationId: expect.stringMatching(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i),
    });
    expect(collection.documents[0]).toMatchObject({ purpose: "login" });
  });

  it("persists the reservation deadline and UUID without restarting the clock after slow storage", async () => {
    const realRates = createOtpRateLimitStore({
      clock, env: {},
      phoneCollection: new MemoryVersionedCollection("phone"),
      sourceCollection: new MemoryVersionedCollection("sourceHash"),
    });
    const result = await makeService({
      rateStore: realRates,
      tokenFactory: () => { clock.advance(9_000); return "slow-token"; },
    }).create({ phone, purpose: "booking" });
    expect(result).toMatchObject({
      retryAt: "2026-08-23T12:01:00.000Z",
      serverTime: "2026-08-23T12:00:09.000Z",
      retryAfterSeconds: 51,
      correlationId: expect.any(String),
    });
    expect(collection.documents[0]).toMatchObject({
      correlationId: result.correlationId,
      retryAt: new Date(result.retryAt),
    });
  });

  it("retains the phone deadline after challenge persistence fails without refunding its claim", async () => {
    const realRates = createOtpRateLimitStore({
      clock, env: {},
      phoneCollection: new MemoryVersionedCollection("phone"),
      sourceCollection: new MemoryVersionedCollection("sourceHash"),
    });
    const service = makeService({
      rateStore: realRates,
      challengeStore: { rotate: vi.fn().mockRejectedValue(new Error("private database detail")) },
    });
    const failed = await service.create({ phone, purpose: "booking" }).catch((error) => error);
    expect(failed).toMatchObject({
      code: "OTP_PERSISTENCE_FAILED",
      retryAt: "2026-08-23T12:01:00.000Z",
      restrictionScope: "phone",
      correlationId: expect.any(String),
    });
    clock.advance(9_000);
    await expect(service.create({ phone, purpose: "booking" })).rejects.toMatchObject({
      code: "OTP_RATE_LIMITED", retryAt: failed.retryAt, retryAfterSeconds: 51,
    });
  });

  it("uses development only with an explicit non-production code", async () => {
    const result = await makeService({
      env: { NODE_ENV: "development", OTP_DEV_CODE: "654321" },
    }).create({
      request: new Request("https://example.com/api/otp/challenge"),
      phone: "0521234567",
      purpose: "booking",
    });

    expect(result.provider).toBe("development");
    expect(JSON.stringify(result)).not.toContain("654321");
    expect(JSON.stringify(collection.documents[0])).not.toContain("654321");
  });

  it("ignores OTP_DEV_CODE in production", async () => {
    const result = await makeService({
      env: { NODE_ENV: "production", OTP_DEV_CODE: "654321" },
    }).create({
      request: new Request("https://example.com/api/otp/challenge"),
      phone: "0521234567",
      purpose: "booking",
    });

    expect(result.provider).toBe("firebase");
  });

  it("performs source, phone, token, provider, and rotation operations in order", async () => {
    const events = [];
    const orderedStore = {
      claimSourceAction: vi.fn(async () => events.push("source")),
      claimPhoneStart: vi.fn(async () => {
        events.push("phone");
        return { retryAfterSeconds: 60 };
      }),
    };
    const orderedChallenges = {
      rotate: vi.fn(async () => {
        events.push("rotate");
        return activeChallenge();
      }),
    };
    const service = makeService({
      deriveSourceHash: vi.fn(() => {
        events.push("derive");
        return "source-hash";
      }),
      rateStore: orderedStore,
      challengeStore: orderedChallenges,
      tokenFactory: vi.fn(() => {
        events.push("token");
        return "challenge-plaintext";
      }),
      hashToken: vi.fn((token) => {
        events.push("hash");
        return hashBearerToken(token);
      }),
    });

    await service.create({
      request: new Request("https://example.com/api/otp/challenge"),
      phone: "0521234567",
      purpose: "booking",
    });

    expect(events).toEqual(["derive", "source", "phone", "token", "hash", "rotate"]);
  });

  it("does not consume a phone claim when the source claim fails", async () => {
    rateStore.claimSourceAction.mockRejectedValue(
      new OtpError("OTP_SOURCE_RATE_LIMITED", 429, "source limited", 60),
    );

    await expect(
      makeService().create({
        request: new Request("https://example.com/api/otp/challenge"),
        phone: "0521234567",
        purpose: "booking",
      }),
    ).rejects.toMatchObject({ code: "OTP_SOURCE_RATE_LIMITED" });
    expect(rateStore.claimPhoneStart).not.toHaveBeenCalled();
  });

  it("passes the actual request and injected environment to source derivation", async () => {
    const request = new Request("https://example.com/api/otp/challenge");
    const env = { NODE_ENV: "test", OTP_SOURCE_HASH_SECRET: "isolated-secret" };
    const sourceExtractor = vi.fn().mockReturnValue("source-hash");

    await makeService({ deriveSourceHash: sourceExtractor, env }).create({
      request,
      phone: "0521234567",
      purpose: "booking",
    });

    expect(sourceExtractor).toHaveBeenCalledWith(request, { env });
  });
});
