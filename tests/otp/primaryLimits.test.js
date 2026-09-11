import { beforeEach, describe, expect, it, vi } from "vitest";
import { assertOtpPurpose } from "@/lib/otp/constants";
import { createOtpRateLimitStore } from "@/lib/otp/rateLimitStore";
import { getRestrictionScope, getRetryDeadline } from "@/lib/otp/retry";
import { createTestClock, MemoryVersionedCollection } from "../helpers/memoryOtpStores";

const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;

describe("Twilio primary send limits", () => {
  let clock;
  let phoneCollection;
  let sourceCollection;
  let store;

  function createStore(env = {}) {
    return createOtpRateLimitStore({ phoneCollection, sourceCollection, clock, env });
  }

  async function claimMany(target, count) {
    for (let index = 0; index < count; index += 1) await target.claimGlobalSend();
  }

  beforeEach(() => {
    clock = createTestClock();
    phoneCollection = new MemoryVersionedCollection("phone");
    sourceCollection = new MemoryVersionedCollection("sourceHash");
    store = createStore();
  });

  it("admits only five racing source sends when the document does not exist", async () => {
    const peer = createStore();
    const results = await Promise.allSettled(Array.from({ length: 12 }, (_, index) =>
      (index % 2 ? peer : store).claimSourceAction("source-a", "send"),
    ));
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(5);
    const failures = results.filter((result) => result.status === "rejected");
    expect(failures).toHaveLength(7);
    for (const failure of failures) {
      expect(failure.reason).toMatchObject({
        code: "OTP_SEND_SOURCE_RATE_LIMITED", status: 429, restrictionScope: "source",
      });
    }
    expect(sourceCollection.documents).toHaveLength(1);
    expect(sourceCollection.documents[0]).toMatchObject({ sendShortCount: 5, sendHourCount: 5 });
  });

  it("expires the source short window exactly at ten minutes without resetting the hour", async () => {
    for (let index = 0; index < 5; index += 1) await store.claimSourceAction("source-a", "send");
    const accepted = structuredClone(sourceCollection.documents[0]);
    clock.advance(599_999);
    await expect(store.claimSourceAction("source-a", "send")).rejects.toMatchObject({
      code: "OTP_SEND_SOURCE_RATE_LIMITED", retryAfterSeconds: 1,
    });
    expect(sourceCollection.documents[0]).toEqual(accepted);
    clock.advance(1);
    await store.claimSourceAction("source-a", "send");
    expect(sourceCollection.documents[0]).toMatchObject({ sendShortCount: 1, sendHourCount: 6 });
  });

  it("expires the source hour at its exact boundary even before TTL cleanup", async () => {
    for (let window = 0; window < 4; window += 1) {
      for (let index = 0; index < 5; index += 1) await store.claimSourceAction("source-a", "send");
      if (window < 3) clock.advance(600_000);
    }
    clock.advance(1_799_999);
    await expect(store.claimSourceAction("source-a", "send")).rejects.toMatchObject({
      code: "OTP_SEND_SOURCE_RATE_LIMITED", retryAfterSeconds: 1,
    });
    clock.advance(1);
    await store.claimSourceAction("source-a", "send");
    expect(sourceCollection.documents[0]).toMatchObject({ sendShortCount: 1, sendHourCount: 1 });
  });

  it("keeps source challenges, source sends, phone starts and global sends independent", async () => {
    for (let index = 0; index < 10; index += 1) await store.claimSourceAction("source-a", "challenge");
    for (let index = 0; index < 5; index += 1) await store.claimSourceAction("source-a", "send");
    await store.claimSourceAction("source-b", "send");
    await store.claimPhoneStart("+972521234567");
    await store.claimGlobalSend();
    expect(sourceCollection.documents).toHaveLength(3);
    expect(phoneCollection.documents).toHaveLength(1);
  });

  it.each(["unknown", "toString", "__proto__"])("rejects unsupported source action %s", (action) => {
    expect(() => store.claimSourceAction("source-a", action)).toThrow(TypeError);
    expect(sourceCollection.documents).toHaveLength(0);
  });

  it("shares the fifty-send hourly budget across store instances and source identities", async () => {
    await claimMany(store, 49);
    const peer = createStore();
    await peer.claimSourceAction("new-source", "send");
    await peer.claimGlobalSend();
    const accepted = structuredClone(sourceCollection.documents);
    clock.advance(9_000);
    await expect(createStore().claimGlobalSend()).rejects.toMatchObject({
      code: "OTP_SEND_BUDGET_EXCEEDED", status: 429, restrictionScope: "global",
      retryAfterSeconds: 3591, retryAt: "2026-08-23T13:00:00.000Z",
      serverTime: "2026-08-23T12:00:09.000Z",
    });
    expect(sourceCollection.documents).toEqual(accepted);
  });

  it("admits exactly one concurrent global send at the default hourly boundary", async () => {
    await claimMany(store, 49);
    const results = await Promise.allSettled(Array.from({ length: 8 }, () =>
      createStore().claimGlobalSend(),
    ));
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    for (const failure of results.filter((result) => result.status === "rejected")) {
      expect(failure.reason).toMatchObject({
        code: "OTP_SEND_BUDGET_EXCEEDED", status: 429, restrictionScope: "global",
        retryAfterSeconds: 3600,
      });
    }
    expect(sourceCollection.documents).toHaveLength(1);
    expect(sourceCollection.documents[0]).toMatchObject({ globalHourCount: 50, globalDayCount: 50 });
  });

  it("recovers initial global insert races without exceeding the configured budget", async () => {
    const results = await Promise.allSettled(Array.from({ length: 8 }, () =>
      createStore({ OTP_GLOBAL_SEND_HOUR_LIMIT: "5" }).claimGlobalSend(),
    ));
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(5);
    for (const failure of results.filter((result) => result.status === "rejected")) {
      expect(failure.reason).toMatchObject({ code: "OTP_SEND_BUDGET_EXCEEDED" });
    }
    expect(sourceCollection.documents).toHaveLength(1);
    expect(sourceCollection.documents[0]).toMatchObject({ globalHourCount: 5, globalDayCount: 5 });
  });

  it("resets the global hour exactly at expiry while retaining the daily count", async () => {
    await claimMany(store, 50);
    clock.advance(HOUR_MS - 1);
    await expect(store.claimGlobalSend()).rejects.toMatchObject({ retryAfterSeconds: 1 });
    clock.advance(1);
    await store.claimGlobalSend();
    expect(sourceCollection.documents[0]).toMatchObject({ globalHourCount: 1, globalDayCount: 51 });
  });

  it("admits one winner at the daily boundary and preserves the longest retry deadline", async () => {
    for (let hour = 0; hour < 3; hour += 1) {
      await claimMany(store, 50);
      clock.advance(HOUR_MS);
    }
    await claimMany(store, 49);
    const results = await Promise.allSettled(Array.from({ length: 6 }, () =>
      createStore().claimGlobalSend(),
    ));
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    for (const failure of results.filter((result) => result.status === "rejected")) {
      expect(failure.reason).toMatchObject({
        code: "OTP_SEND_BUDGET_EXCEEDED", status: 429, restrictionScope: "global",
        retryAfterSeconds: 75_600, retryAt: "2026-08-24T12:00:00.000Z",
      });
    }
    const accepted = structuredClone(sourceCollection.documents[0]);
    clock.advance(HOUR_MS);
    await expect(store.claimGlobalSend()).rejects.toMatchObject({
      code: "OTP_SEND_BUDGET_EXCEEDED", retryAfterSeconds: 72_000,
    });
    expect(sourceCollection.documents[0]).toEqual(accepted);
    clock.advance(20 * HOUR_MS - 1);
    await expect(store.claimGlobalSend()).rejects.toMatchObject({ retryAfterSeconds: 1 });
    clock.advance(1);
    await store.claimGlobalSend();
    expect(sourceCollection.documents[0]).toMatchObject({ globalHourCount: 1, globalDayCount: 1 });
  });

  it("retains global state beyond twenty-four hours without extending rejected activity", async () => {
    const configured = createStore({ OTP_GLOBAL_SEND_DAY_LIMIT: "1" });
    await configured.claimGlobalSend();
    const accepted = structuredClone(sourceCollection.documents[0]);
    expect(accepted.expiresAt.getTime()).toBeGreaterThan(clock.now().getTime() + DAY_MS);
    clock.advance(3 * HOUR_MS);
    await expect(createStore({ OTP_GLOBAL_SEND_DAY_LIMIT: "1" }).claimGlobalSend()).rejects.toMatchObject({
      code: "OTP_SEND_BUDGET_EXCEEDED", retryAfterSeconds: 75_600,
    });
    expect(sourceCollection.documents[0]).toEqual(accepted);
  });

  it("does not let source actions overwrite the dedicated global key or its retention", async () => {
    await store.claimGlobalSend();
    const accepted = structuredClone(sourceCollection.documents[0]);
    expect(() => store.claimSourceAction(accepted.sourceHash, "send")).toThrow(TypeError);
    expect(() => store.claimSourceAction(accepted.sourceHash, "challenge")).toThrow(TypeError);
    expect(sourceCollection.documents[0]).toEqual(accepted);
  });

  it("retains the finite CAS retry bound and fails closed on repeated global conflicts", async () => {
    await store.claimGlobalSend();
    const accepted = structuredClone(sourceCollection.documents[0]);
    sourceCollection.forcedCasConflicts = 8;
    await expect(store.claimGlobalSend()).rejects.toMatchObject({ code: "OTP_STATE_BUSY", status: 503 });
    expect(sourceCollection.documents[0]).toEqual(accepted);
  });

  it.each(["findOne", "insertOne", "updateOne"])("does not replace failed durable %s with a local allowance", async (method) => {
    if (method === "updateOne") await store.claimGlobalSend();
    const accepted = structuredClone(sourceCollection.documents);
    vi.spyOn(sourceCollection, method).mockRejectedValue(new Error("Persistence unavailable"));
    await expect(store.claimGlobalSend()).rejects.toThrow("Persistence unavailable");
    expect(sourceCollection.documents).toEqual(accepted);
  });

  it("refuses global claims when durable index creation fails", async () => {
    expect(store.claimGlobalSend).toBeTypeOf("function");
    vi.spyOn(sourceCollection, "createIndex").mockRejectedValue(new Error("Index unavailable"));
    await expect(createStore().claimGlobalSend()).rejects.toThrow("Index unavailable");
    expect(sourceCollection.documents).toHaveLength(0);
  });

  it.each(["0", "-1", "Infinity", "NaN", "1.5", "6junk", "", " ", "1e2", "999999", null, {}, true, Infinity])(
    "uses finite hourly and daily defaults for malformed global configuration %j", async (value) => {
      vi.spyOn(console, "info").mockImplementation(() => {});
      const configured = createStore({ OTP_GLOBAL_SEND_HOUR_LIMIT: value, OTP_GLOBAL_SEND_DAY_LIMIT: value });
      for (let hour = 0; hour < 4; hour += 1) {
        await claimMany(configured, 50);
        await expect(configured.claimGlobalSend()).rejects.toMatchObject({
          code: "OTP_SEND_BUDGET_EXCEEDED", restrictionScope: "global",
          retryAfterSeconds: hour < 3 ? 3600 : 75_600,
        });
        clock.advance(HOUR_MS);
      }
      await expect(configured.claimGlobalSend()).rejects.toMatchObject({
        code: "OTP_SEND_BUDGET_EXCEEDED", retryAfterSeconds: 72_000,
      });
    },
  );

  it.each([
    ["OTP_GLOBAL_SEND_HOUR_LIMIT", "201", 50, 0, 3600],
    ["OTP_GLOBAL_SEND_DAY_LIMIT", "1001", 200, 50, 75_600],
  ])("rejects values above the hard ceiling for %s", async (key, value, count, batchSize, retryAfterSeconds) => {
    const configured = createStore({ [key]: value });
    for (let index = 0; index < count; index += 1) {
      if (batchSize && index > 0 && index % batchSize === 0) clock.advance(HOUR_MS);
      await configured.claimGlobalSend();
    }
    await expect(configured.claimGlobalSend()).rejects.toMatchObject({
      code: "OTP_SEND_BUDGET_EXCEEDED", retryAfterSeconds,
    });
  });

  it("supports bounded maximum configuration without disabling either global window", async () => {
    const configured = createStore({ OTP_GLOBAL_SEND_HOUR_LIMIT: "200", OTP_GLOBAL_SEND_DAY_LIMIT: "1000" });
    for (let hour = 0; hour < 5; hour += 1) {
      await claimMany(configured, 200);
      await expect(configured.claimGlobalSend()).rejects.toMatchObject({
        code: "OTP_SEND_BUDGET_EXCEEDED", retryAfterSeconds: hour < 4 ? 3600 : 72_000,
      });
      clock.advance(HOUR_MS);
    }
    await expect(configured.claimGlobalSend()).rejects.toMatchObject({
      code: "OTP_SEND_BUDGET_EXCEEDED", retryAfterSeconds: 68_400,
    });
  });
});

describe("primary OTP purpose and retry policy", () => {
  it.each(["booking", "login"])("continues accepting the %s purpose", (purpose) => {
    expect(assertOtpPurpose(purpose)).toBe(purpose);
  });

  it.each([undefined, "", "send", "other"])("continues rejecting invalid purpose %j", (purpose) => {
    expect(() => assertOtpPurpose(purpose)).toThrow(expect.objectContaining({ code: "INVALID_OTP_PURPOSE" }));
  });

  it.each([
    ["OTP_SOURCE_RATE_LIMITED", "source"],
    ["OTP_SEND_SOURCE_RATE_LIMITED", "source"],
    ["OTP_SEND_BUDGET_EXCEEDED", "global"],
    ["OTP_RATE_LIMITED", "phone"],
    ["OTP_VERIFY_RATE_LIMITED", "phone"],
  ])("maps %s to the %s restriction scope", (code, scope) => {
    expect(getRestrictionScope(code)).toBe(scope);
  });

  it("translates the full daily budget retry from server time despite client clock skew", () => {
    const now = Date.parse("2026-08-23T10:00:00.000Z");
    expect(getRetryDeadline({
      error: "OTP_SEND_BUDGET_EXCEEDED", restrictionScope: "global",
      serverTime: "2026-08-23T15:00:00.000Z", retryAt: "2026-08-24T12:00:00.000Z",
      retryAfterSeconds: 75_600,
    }, now)).toBe(now + 75_600_000);
  });

  it.each([
    { restrictionScope: "global" },
    { error: "OTP_SEND_BUDGET_EXCEEDED" },
    { code: "OTP_SEND_BUDGET_EXCEEDED" },
  ])("supports finite daily Retry-After and absolute deadlines for %j", (identity) => {
    const now = Date.parse("2026-08-23T12:00:00.000Z");
    expect(getRetryDeadline({ ...identity, retryAfterSeconds: 86_400 }, now)).toBe(now + DAY_MS);
    expect(getRetryDeadline({ ...identity, retryAfterSeconds: 172_800 }, now)).toBe(now + DAY_MS);
    expect(getRetryDeadline({ ...identity, retryAt: "2026-08-24T09:00:00.000Z" }, now)).toBe(now + 75_600_000);
  });

  it("keeps non-global retry deadlines capped at one hour", () => {
    const now = Date.parse("2026-08-23T12:00:00.000Z");
    expect(getRetryDeadline({ retryAfterSeconds: 86_400, restrictionScope: "source" }, now)).toBe(now + HOUR_MS);
    expect(getRetryDeadline({ retryAfterSeconds: Infinity, restrictionScope: "global" }, now)).toBe(0);
  });
});
