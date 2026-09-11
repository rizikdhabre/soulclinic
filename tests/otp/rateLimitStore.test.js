import { beforeEach, describe, expect, it, vi } from "vitest";
import { createOtpRateLimitStore } from "@/lib/otp/rateLimitStore";
import {
  createTestClock,
  MemoryVersionedCollection,
} from "../helpers/memoryOtpStores";

const phone = "+972521234567";

describe("createOtpRateLimitStore", () => {
  let clock;
  let phoneCollection;
  let sourceCollection;
  let store;

  beforeEach(() => {
    clock = createTestClock();
    phoneCollection = new MemoryVersionedCollection("phone");
    sourceCollection = new MemoryVersionedCollection("sourceHash");
    store = createOtpRateLimitStore({ phoneCollection, sourceCollection, clock, env: {} });
  });

  it("rejects a second phone start inside 60 seconds", async () => {
    await store.claimPhoneStart(phone);

    await expect(store.claimPhoneStart(phone)).rejects.toMatchObject({
      code: "OTP_RATE_LIMITED",
      status: 429,
      retryAfterSeconds: 60,
    });
    expect(phoneCollection.documents).toHaveLength(1);
  });

  it("returns one authoritative phone deadline, including a retry nine seconds later", async () => {
    const first = await store.claimPhoneStart(phone);
    expect(first).toMatchObject({
      retryAt: "2026-08-23T12:01:00.000Z",
      serverTime: "2026-08-23T12:00:00.000Z",
      retryAfterSeconds: 60,
      restrictionScope: "phone",
    });
    clock.advance(9_000);
    await expect(store.claimPhoneStart(phone)).rejects.toMatchObject({
      code: "OTP_RATE_LIMITED",
      retryAt: first.retryAt,
      serverTime: "2026-08-23T12:00:09.000Z",
      retryAfterSeconds: 51,
      restrictionScope: "phone",
    });
    await expect(store.claimPhoneStart("+972521234568")).resolves.toMatchObject({
      restrictionScope: "phone",
      retryAfterSeconds: 60,
    });
  });

  it.each([
    ["challenge", "OTP_SOURCE_CHALLENGE_SHORT_LIMIT", "OTP_SOURCE_CHALLENGE_HOUR_LIMIT", 12, 15],
    ["send", "OTP_SOURCE_SEND_SHORT_LIMIT", "OTP_SOURCE_SEND_HOUR_LIMIT", 6, 8],
  ])("applies finite configured %s limits to both source windows", async (action, shortKey, hourKey, short, hour) => {
    const configured = createOtpRateLimitStore({
      phoneCollection, sourceCollection, clock,
      env: { [shortKey]: String(short), [hourKey]: String(hour) },
    });
    for (let index = 0; index < short; index += 1) {
      await configured.claimSourceAction("shared-source", action);
    }
    await expect(configured.claimSourceAction("shared-source", action)).rejects.toMatchObject({
      restrictionScope: "source",
      retryAt: "2026-08-23T12:10:00.000Z",
      serverTime: "2026-08-23T12:00:00.000Z",
      retryAfterSeconds: 600,
    });
    clock.advance(600_000);
    for (let index = short; index < hour; index += 1) {
      await configured.claimSourceAction("shared-source", action);
    }
    await expect(configured.claimSourceAction("shared-source", action)).rejects.toMatchObject({
      restrictionScope: "source",
      retryAt: "2026-08-23T13:00:00.000Z",
      retryAfterSeconds: 3000,
    });
  });

  it.each(["0", "-1", "Infinity", "NaN", "1.5", "6junk", "", " ", "1e2", "999999", null, {}, true])(
    "fails safe to finite defaults for invalid source limits %j", async (value) => {
      const configured = createOtpRateLimitStore({
        phoneCollection, sourceCollection, clock,
        env: {
          OTP_SOURCE_CHALLENGE_SHORT_LIMIT: value,
          OTP_SOURCE_CHALLENGE_HOUR_LIMIT: value,
          OTP_SOURCE_SEND_SHORT_LIMIT: value,
          OTP_SOURCE_SEND_HOUR_LIMIT: value,
        },
      });
      for (let index = 0; index < 5; index += 1) {
        await configured.claimSourceAction("shared-source", "send");
      }
      await expect(configured.claimSourceAction("shared-source", "send")).rejects.toMatchObject({
        code: "OTP_SEND_SOURCE_RATE_LIMITED",
        restrictionScope: "source",
      });
    },
  );

  it("retains one winner at the configured send boundary under concurrent access", async () => {
    const configured = createOtpRateLimitStore({
      phoneCollection, sourceCollection, clock,
      env: { OTP_SOURCE_SEND_SHORT_LIMIT: "6" },
    });
    for (let index = 0; index < 5; index += 1) {
      await configured.claimSourceAction("shared-source", "send");
    }
    const results = await Promise.allSettled(Array.from({ length: 4 }, () =>
      configured.claimSourceAction("shared-source", "send"),
    ));
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected").every((result) =>
      result.reason.code === "OTP_SEND_SOURCE_RATE_LIMITED" && result.reason.restrictionScope === "source",
    )).toBe(true);
    expect(sourceCollection.documents[0].sendShortCount).toBe(6);
  });

  it("rejects the sixth phone start inside one hour", async () => {
    for (let index = 0; index < 5; index += 1) {
      await store.claimPhoneStart(phone);
      clock.advance(61_000);
    }

    await expect(store.claimPhoneStart(phone)).rejects.toMatchObject({
      code: "OTP_RATE_LIMITED",
      retryAfterSeconds: 3_295,
    });
    expect(phoneCollection.documents).toHaveLength(1);
  });

  it("returns the longest retry when cooldown and hourly phone limits overlap", async () => {
    for (let index = 0; index < 5; index += 1) {
      await store.claimPhoneStart(phone);
      if (index < 4) clock.advance(61_000);
    }

    await expect(store.claimPhoneStart(phone)).rejects.toMatchObject({
      code: "OTP_RATE_LIMITED",
      retryAfterSeconds: 3_356,
    });
  });

  it("advertises the hourly deadline as soon as the fifth phone reservation fills the window", async () => {
    for (let index = 0; index < 4; index += 1) {
      await store.claimPhoneStart(phone);
      clock.advance(60_000);
    }
    const fifth = await store.claimPhoneStart(phone);
    expect(fifth).toMatchObject({
      retryAt: "2026-08-23T13:00:00.000Z", retryAfterSeconds: 3360, restrictionScope: "phone",
    });
    clock.advance(9_000);
    await expect(store.claimPhoneStart(phone)).rejects.toMatchObject({
      retryAt: fifth.retryAt, retryAfterSeconds: 3351,
    });
  });

  it.each([
    ["challenge", "OTP_SOURCE_CHALLENGE_SHORT_LIMIT", 30],
    ["challenge", "OTP_SOURCE_CHALLENGE_HOUR_LIMIT", 90],
    ["send", "OTP_SOURCE_SEND_SHORT_LIMIT", 20],
    ["send", "OTP_SOURCE_SEND_HOUR_LIMIT", 60],
  ])("rejects values above the documented hard bound for %s %s", async (action, key, max) => {
    const configured = createOtpRateLimitStore({
      phoneCollection, sourceCollection, clock, env: { [key]: String(max + 1) },
    });
    const short = action === "challenge" ? 10 : 5;
    const hour = action === "challenge" ? 30 : 20;
    const limit = key.includes("SHORT") ? short : hour;
    for (let index = 0; index < limit; index += 1) {
      if (index > 0 && index % short === 0) clock.advance(600_000);
      await configured.claimSourceAction("bounded-source", action);
    }
    await expect(configured.claimSourceAction("bounded-source", action)).rejects.toMatchObject({
      restrictionScope: "source", status: 429,
    });
  });

  it("leaves rejected claims unchanged and extends retention only on accepted activity", async () => {
    await store.claimPhoneStart(phone);
    const acceptedState = structuredClone(phoneCollection.documents[0]);
    clock.advance(1_000);

    await expect(store.claimPhoneStart(phone)).rejects.toMatchObject({
      code: "OTP_RATE_LIMITED",
      status: 429,
    });

    const rejectedState = phoneCollection.documents[0];
    expect(rejectedState.version).toBe(acceptedState.version);
    expect(rejectedState.updatedAt).toEqual(acceptedState.updatedAt);
    expect(rejectedState.expiresAt).toEqual(acceptedState.expiresAt);

    clock.advance(3_599_001);

    const result = await store.claimPhoneStart(phone);

    expect(result).toMatchObject({ retryAfterSeconds: 60 });
    expect(phoneCollection.documents[0]).toMatchObject({ sendCount: 1, version: 2 });
    expect(phoneCollection.documents[0].expiresAt.getTime()).toBeGreaterThan(
      acceptedState.expiresAt.getTime(),
    );
  });

  it("limits challenge creation across different phone numbers by source", async () => {
    for (let index = 0; index < 10; index += 1) {
      await store.claimSourceAction("source-a", "challenge");
    }

    await expect(store.claimSourceAction("source-a", "challenge")).rejects.toMatchObject({
      code: "OTP_SOURCE_RATE_LIMITED",
      retryAfterSeconds: 600,
    });
    expect(sourceCollection.documents).toHaveLength(1);
  });

  it("rejects the thirty-first source challenge inside one hour", async () => {
    for (let window = 0; window < 3; window += 1) {
      for (let index = 0; index < 10; index += 1) {
        await store.claimSourceAction("source-a", "challenge");
      }
      if (window < 2) clock.advance(10 * 60_000 + 1);
    }

    await expect(store.claimSourceAction("source-a", "challenge")).rejects.toMatchObject({
      code: "OTP_SOURCE_RATE_LIMITED",
      retryAfterSeconds: 2_400,
    });
  });

  it("limits source sends to five per ten minutes", async () => {
    for (let index = 0; index < 5; index += 1) {
      await store.claimSourceAction("source-a", "send");
    }

    await expect(store.claimSourceAction("source-a", "send")).rejects.toMatchObject({
      code: "OTP_SEND_SOURCE_RATE_LIMITED",
      retryAfterSeconds: 600,
    });
  });

  it("rejects the twenty-first source send inside one hour", async () => {
    for (let window = 0; window < 4; window += 1) {
      for (let index = 0; index < 5; index += 1) {
        await store.claimSourceAction("source-a", "send");
      }
      if (window < 3) clock.advance(600_000);
    }

    await expect(store.claimSourceAction("source-a", "send")).rejects.toMatchObject({
      code: "OTP_SEND_SOURCE_RATE_LIMITED",
      retryAfterSeconds: 1_800,
    });
  });

  it("stores one bounded verification counter without submitted values", async () => {
    await store.recordPhoneVerifyFailure(phone);
    await store.recordPhoneVerifyFailure(phone);

    expect(phoneCollection.documents).toHaveLength(1);
    expect(phoneCollection.documents[0]).toMatchObject({ verifyFailureCount: 2, version: 2 });
    expect(JSON.stringify(phoneCollection.documents[0])).not.toContain("654321");
  });

  it("blocks after five verification failures and clears the bounded counter", async () => {
    for (let index = 0; index < 5; index += 1) {
      await store.recordPhoneVerifyFailure(phone);
    }

    await expect(store.getPhoneVerifyLimit(phone)).rejects.toMatchObject({
      code: "OTP_VERIFY_RATE_LIMITED",
      status: 429,
      retryAfterSeconds: 600,
    });
    await expect(store.recordPhoneVerifyFailure(phone)).rejects.toMatchObject({
      code: "OTP_VERIFY_RATE_LIMITED",
    });

    await store.clearPhoneVerifyFailures(phone);

    await expect(store.getPhoneVerifyLimit(phone)).resolves.toEqual({
      remainingFailures: 5,
    });
    expect(phoneCollection.documents[0]).toMatchObject({
      verifyWindowStartedAt: null,
      verifyFailureCount: 0,
      blockedUntil: null,
      version: 6,
    });
  });

  it("atomically reserves at most five owned verification attempts", async () => {
    const reservationIds = Array.from(
      { length: 6 },
      (_, index) => `verify-attempt-${index + 1}`,
    );

    const results = await Promise.allSettled(
      reservationIds.map((reservationId) =>
        store.reservePhoneVerifyAttempt(phone, reservationId),
      ),
    );

    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(5);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
    expect(results.find((result) => result.status === "rejected")?.reason).toMatchObject({
      code: "OTP_VERIFY_RATE_LIMITED",
      status: 429,
    });
    expect(phoneCollection.documents).toHaveLength(1);
    expect(phoneCollection.documents[0]).toMatchObject({
      verifyFailureCount: 5,
      verifyReservationIds: reservationIds.slice(0, 5),
      version: 5,
    });
  });

  it("reserves idempotently and releases only the exact owned attempt", async () => {
    await store.reservePhoneVerifyAttempt(phone, "verify-attempt-1");
    const reserved = structuredClone(phoneCollection.documents[0]);

    await expect(
      store.reservePhoneVerifyAttempt(phone, "verify-attempt-1"),
    ).resolves.toEqual({ verifyFailureCount: 1, blockedUntil: null });
    expect(phoneCollection.documents[0]).toEqual(reserved);

    await expect(
      store.releasePhoneVerifyAttempt(phone, "different-attempt"),
    ).resolves.toEqual({ released: false });
    expect(phoneCollection.documents[0]).toEqual(reserved);

    await expect(
      store.releasePhoneVerifyAttempt(phone, "verify-attempt-1"),
    ).resolves.toEqual({ released: true });
    expect(phoneCollection.documents[0]).toMatchObject({
      verifyWindowStartedAt: null,
      verifyFailureCount: 0,
      verifyReservationIds: [],
      blockedUntil: null,
      version: 2,
    });

    const released = structuredClone(phoneCollection.documents[0]);
    await expect(
      store.releasePhoneVerifyAttempt(phone, "verify-attempt-1"),
    ).resolves.toEqual({ released: false });
    expect(phoneCollection.documents[0]).toEqual(released);
  });

  it("admits exactly one concurrent claim at the source boundary", async () => {
    for (let index = 0; index < 9; index += 1) {
      await store.claimSourceAction("source-a", "challenge");
    }

    const results = await Promise.allSettled(
      Array.from({ length: 2 }, () => store.claimSourceAction("source-a", "challenge")),
    );

    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
    expect(
      results
        .filter((result) => result.status === "rejected")
        .every((result) => result.reason.code === "OTP_SOURCE_RATE_LIMITED"),
    ).toBe(true);
    expect(sourceCollection.documents).toHaveLength(1);
    expect(sourceCollection.documents[0]).toMatchObject({
      challengeShortCount: 10,
      challengeHourCount: 10,
      version: 10,
    });
  });

  it("recovers a concurrent duplicate-key insert into one source document", async () => {
    const results = await Promise.all([
      store.claimSourceAction("source-new", "challenge"),
      store.claimSourceAction("source-new", "challenge"),
    ]);

    expect(results).toEqual([undefined, undefined]);
    expect(sourceCollection.duplicateKeyErrors).toBe(1);
    expect(sourceCollection.documents).toHaveLength(1);
    expect(sourceCollection.documents[0]).toMatchObject({
      sourceHash: "source-new",
      challengeShortCount: 2,
      challengeHourCount: 2,
      version: 2,
    });
  });

  it("creates unique identity and absolute TTL indexes on both collections", async () => {
    await store.claimPhoneStart(phone);
    await store.claimSourceAction("source-a", "challenge");

    expect(phoneCollection.indexes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          keys: { phone: 1 },
          options: expect.objectContaining({ unique: true }),
        }),
        expect.objectContaining({
          keys: { expiresAt: 1 },
          options: expect.objectContaining({ expireAfterSeconds: 0 }),
        }),
      ]),
    );
    expect(sourceCollection.indexes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          keys: { sourceHash: 1 },
          options: expect.objectContaining({ unique: true }),
        }),
        expect.objectContaining({
          keys: { expiresAt: 1 },
          options: expect.objectContaining({ expireAfterSeconds: 0 }),
        }),
      ]),
    );
  });

  it("fails busy after eight consecutive CAS conflicts", async () => {
    await store.claimPhoneStart(phone);
    clock.advance(61_000);
    phoneCollection.forcedCasConflicts = 8;

    await expect(store.claimPhoneStart(phone)).rejects.toMatchObject({
      code: "OTP_STATE_BUSY",
      status: 503,
    });
    expect(phoneCollection.documents[0]).toMatchObject({ sendCount: 1, version: 1 });
  });

  it("uses primary majority reads and majority writes for all durable counters", async () => {
    const spies = [phoneCollection, sourceCollection].map((collection) => ({
      read: vi.spyOn(collection, "findOne"),
      insert: vi.spyOn(collection, "insertOne"),
      update: vi.spyOn(collection, "updateOne"),
    }));
    await store.claimPhoneStart(phone);
    clock.advance(60_000);
    await store.claimPhoneStart(phone);
    await store.reservePhoneVerifyAttempt(phone, "verify-owned");
    await store.getPhoneVerifyLimit(phone);
    await store.releasePhoneVerifyAttempt(phone, "verify-owned");
    await store.claimSourceAction("source-a", "send");
    await store.claimSourceAction("source-a", "send");
    await store.claimGlobalSend();
    await store.claimGlobalSend();
    for (const { read, insert, update } of spies) {
      expect(read).toHaveBeenCalled();
      expect(insert).toHaveBeenCalled();
      expect(update).toHaveBeenCalled();
      for (const [, options] of read.mock.calls) {
        expect(options).toEqual({ readPreference: "primary", readConcern: { level: "majority" } });
      }
      for (const [, options] of insert.mock.calls) {
        expect(options).toEqual({ writeConcern: { w: "majority" } });
      }
      for (const [, , options] of update.mock.calls) {
        expect(options).toEqual({ writeConcern: { w: "majority" } });
      }
    }
  });

  it("exposes index readiness and shares successful initialization across callers", async () => {
    expect(store.ensureIndexes).toBeTypeOf("function");
    expect(phoneCollection.indexes).toHaveLength(0);
    expect(sourceCollection.indexes).toHaveLength(0);
    await Promise.all([store.ensureIndexes(), store.ensureIndexes(), store.claimGlobalSend()]);
    await store.ensureIndexes();
    expect(phoneCollection.indexes).toHaveLength(2);
    expect(sourceCollection.indexes).toHaveLength(2);
    for (const { options } of [...phoneCollection.indexes, ...sourceCollection.indexes]) {
      expect(options.writeConcern).toEqual({ w: "majority" });
    }
  });

  it("retries failed index initialization on the same cached store before admitting a send", async () => {
    vi.spyOn(sourceCollection, "createIndex").mockRejectedValueOnce(new Error("Index unavailable"));
    const configured = createOtpRateLimitStore({ phoneCollection, sourceCollection, clock, env: {} });
    await expect(configured.claimGlobalSend()).rejects.toThrow("Index unavailable");
    expect(sourceCollection.documents).toHaveLength(0);
    await expect(configured.claimGlobalSend()).resolves.toBeUndefined();
    expect(sourceCollection.documents).toHaveLength(1);
    expect(sourceCollection.documents[0]).toMatchObject({ globalHourCount: 1, globalDayCount: 1 });
  });
});
