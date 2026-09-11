import { beforeEach, describe, expect, it, vi } from "vitest";
import { createOtpChallengeService } from "@/lib/otp/challengeService";
import { createOtpChallengeStore } from "@/lib/otp/challengeStore";
import { hashBearerToken } from "@/lib/otp/crypto";
import { OtpError } from "@/lib/otp/errors";
import { createTestClock, MemoryMongoCollection } from "../helpers/memoryOtpStores";

const PHONE = "+972521234567";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

describe("Twilio challenge preparation", () => {
  let clock;
  let collection;
  let deps;
  let service;

  beforeEach(() => {
    vi.spyOn(console, "info").mockImplementation(() => {});
    clock = createTestClock();
    collection = new MemoryMongoCollection();
    deps = {
      env: { NODE_ENV: "test", CUSTOMER_SESSION_SECRET: "s".repeat(48) },
      clock, challengeStore: createOtpChallengeStore({ collection }),
      deriveSourceHash: vi.fn().mockResolvedValue("source-hash"),
      rateStore: {
        claimSourceAction: vi.fn().mockResolvedValue(undefined),
        claimPhoneStart: vi.fn(async () => ({ retryAt: new Date(+clock.now() + 60_000).toISOString() })),
      },
      usersData: { findOne: vi.fn() },
      sendVerification: vi.fn(),
    };
    service = createOtpChallengeService(deps);
  });

  it.each(["booking", "login"])("prepares a normalized %s challenge with only a bearer hash in storage", async (purpose) => {
    const result = await service.create({ phone: "052-123-4567", purpose });
    expect(result).toEqual({
      challengeToken: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/), provider: "twilio",
      expiresAt: new Date("2026-08-23T12:10:00.000Z"), correlationId: expect.stringMatching(UUID),
      retryAt: "2026-08-23T12:01:00.000Z", serverTime: "2026-08-23T12:00:00.000Z", retryAfterSeconds: 60,
    });
    expect(collection.current).toMatchObject({
      phone: PHONE, purpose, provider: "twilio", status: "prepared",
      challengeTokenHash: hashBearerToken(result.challengeToken), sourceHash: "source-hash",
      correlationId: result.correlationId, expiresAt: result.expiresAt,
      createdAt: clock.now(), retryAt: new Date(result.retryAt),
    });
    expect(JSON.stringify(collection.documents)).not.toContain(result.challengeToken);
    expect(deps.rateStore.claimPhoneStart).toHaveBeenCalledExactlyOnceWith(PHONE);
    expect(deps.usersData.findOne).not.toHaveBeenCalled();
    expect(deps.sendVerification).not.toHaveBeenCalled();
  });

  it("keeps previous challenges unchanged when the same phone prepares a later attempt", async () => {
    const first = await service.create({ phone: PHONE, purpose: "booking" });
    const original = await deps.challengeStore.findByTokenHash(hashBearerToken(first.challengeToken));
    clock.advance(60_000);
    const second = await service.create({ phone: PHONE, purpose: "booking" });
    expect(second.challengeToken).not.toBe(first.challengeToken);
    expect(second.correlationId).not.toBe(first.correlationId);
    expect(await deps.challengeStore.findByTokenHash(hashBearerToken(first.challengeToken))).toEqual(original);
    expect(collection.documents).toHaveLength(2);
  });

  it.each([undefined, null, "", "123", "+12025550123", {}, []])(
    "consumes only the source claim for invalid phone %j", async (phone) => {
      await expect(service.create({ phone, purpose: "booking" })).rejects.toMatchObject({ code: "INVALID_PHONE", status: 400 });
      expect(deps.rateStore.claimSourceAction).toHaveBeenCalledExactlyOnceWith("source-hash", "challenge");
      expect(deps.rateStore.claimPhoneStart).not.toHaveBeenCalled();
      expect(collection.documents).toEqual([]);
    },
  );

  it.each([undefined, null, "", "admin", "booking ", ["booking"]])(
    "rejects purpose %j before claiming the phone", async (purpose) => {
      await expect(service.create({ phone: PHONE, purpose })).rejects.toMatchObject({ code: "INVALID_OTP_PURPOSE", status: 400 });
      expect(deps.rateStore.claimSourceAction).toHaveBeenCalledTimes(1);
      expect(deps.rateStore.claimPhoneStart).not.toHaveBeenCalled();
      expect(collection.documents).toEqual([]);
    },
  );

  it.each([undefined, null])("handles an absent request body %j as an invalid phone", async (input) => {
    await expect(service.create(input)).rejects.toMatchObject({ code: "INVALID_PHONE", status: 400 });
    expect(deps.rateStore.claimPhoneStart).not.toHaveBeenCalled();
  });

  it("passes the exact request and environment to source derivation before rate claims", async () => {
    const events = [];
    const request = { headers: new Headers({ "x-test": "request-context" }) };
    deps.deriveSourceHash.mockImplementation(async () => { events.push("source-identity"); return "source-hash"; });
    deps.rateStore.claimSourceAction.mockImplementation(async () => { events.push("source-claim"); });
    deps.rateStore.claimPhoneStart.mockImplementation(async () => { events.push("phone-claim"); });
    vi.spyOn(collection, "insertOne").mockImplementation(async () => { events.push("insert"); });
    await service.create({ request, phone: PHONE, purpose: "booking" });
    expect(events).toEqual(["source-identity", "source-claim", "phone-claim", "insert"]);
    expect(deps.deriveSourceHash).toHaveBeenCalledExactlyOnceWith(request, { env: deps.env });
  });

  it("preserves the reservation deadline and expiry across a slow database insert", async () => {
    const insertOne = collection.insertOne.bind(collection);
    vi.spyOn(collection, "insertOne").mockImplementation(async (...args) => {
      clock.advance(2_500);
      return insertOne(...args);
    });
    const result = await service.create({ phone: PHONE, purpose: "login" });
    expect(result).toMatchObject({
      retryAt: "2026-08-23T12:01:00.000Z", retryAfterSeconds: 58,
      serverTime: "2026-08-23T12:00:02.500Z", expiresAt: new Date("2026-08-23T12:10:00.000Z"),
    });
    expect(collection.current.retryAt).toEqual(new Date(result.retryAt));
    expect(collection.current.createdAt).toEqual(new Date("2026-08-23T12:00:00.000Z"));
  });

  it("does not restart an elapsed cooldown after slow persistence", async () => {
    const insertOne = collection.insertOne.bind(collection);
    vi.spyOn(collection, "insertOne").mockImplementation(async (...args) => {
      clock.advance(60_001);
      return insertOne(...args);
    });
    expect(await service.create({ phone: PHONE, purpose: "booking" })).toMatchObject({
      retryAt: "2026-08-23T12:01:00.000Z", retryAfterSeconds: 0,
      expiresAt: new Date("2026-08-23T12:10:00.000Z"),
    });
  });

  it("retains cooldown metadata and sanitizes a failed challenge insert", async () => {
    vi.spyOn(collection, "insertOne").mockRejectedValue(new Error(`database failed for ${PHONE}`));
    const error = await service.create({ phone: PHONE, purpose: "booking" }).catch((failure) => failure);
    expect(error).toMatchObject({
      code: "OTP_PERSISTENCE_FAILED", status: 503, correlationId: expect.stringMatching(UUID),
      retryAt: "2026-08-23T12:01:00.000Z", retryAfterSeconds: 60, restrictionScope: "phone",
      serverTime: "2026-08-23T12:00:00.000Z",
    });
    expect(error.message).not.toContain(PHONE);
    expect(collection.documents).toEqual([]);
    expect(deps.rateStore.claimPhoneStart).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(console.info.mock.calls)).not.toContain(PHONE);
  });

  it("retains a source restriction without consuming a phone claim", async () => {
    deps.rateStore.claimSourceAction.mockRejectedValue(new OtpError("OTP_SOURCE_RATE_LIMITED", 429, "Limited", 600, {
      retryAt: "2026-08-23T12:10:00.000Z", restrictionScope: "source",
    }));
    await expect(service.create({ phone: PHONE, purpose: "booking" })).rejects.toMatchObject({
      code: "OTP_SOURCE_RATE_LIMITED", status: 429, restrictionScope: "source",
      retryAt: "2026-08-23T12:10:00.000Z", retryAfterSeconds: 600, correlationId: expect.stringMatching(UUID),
    });
    expect(deps.rateStore.claimPhoneStart).not.toHaveBeenCalled();
    expect(collection.documents).toEqual([]);
  });

  it("fails closed when source derivation or phone reservation is unavailable", async () => {
    deps.deriveSourceHash.mockRejectedValueOnce(new OtpError("OTP_SOURCE_UNAVAILABLE", 503, "Unavailable"));
    await expect(service.create({ phone: PHONE, purpose: "booking" })).rejects.toMatchObject({ code: "OTP_SOURCE_UNAVAILABLE" });
    expect(deps.rateStore.claimSourceAction).not.toHaveBeenCalled();
    deps.rateStore.claimPhoneStart.mockRejectedValueOnce(new Error("database unavailable"));
    await expect(service.create({ phone: PHONE, purpose: "booking" })).rejects.toMatchObject({ code: "OTP_PERSISTENCE_FAILED", status: 503 });
    expect(collection.documents).toEqual([]);
  });
});
