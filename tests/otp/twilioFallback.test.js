import { beforeEach, describe, expect, it, vi } from "vitest";
import { createOtpChallengeStore } from "@/lib/otp/challengeStore";
import { hashBearerToken } from "@/lib/otp/crypto";
import { createOtpRateLimitStore } from "@/lib/otp/rateLimitStore";
import { createOtpChallengeService } from "@/lib/otp/challengeService";
import {
  classifyTwilioSendError,
  classifyTwilioVerifyError,
  sendTwilioVerification,
  verifyTwilioCode,
} from "@/lib/twilioOTP";
import { requestTwilioFallback } from "@/lib/otp/twilioFallback";
import {
  createTestClock,
  MemoryVersionedCollection,
} from "../helpers/memoryOtpStores";

const { getTwilioClientMock, getTwilioVerifyConfigMock } = vi.hoisted(() => ({
  getTwilioClientMock: vi.fn(),
  getTwilioVerifyConfigMock: vi.fn(),
}));

vi.mock("@/lib/twilio", () => ({
  getTwilioClient: getTwilioClientMock,
  getTwilioVerifyConfig: getTwilioVerifyConfigMock,
}));

const storedPhone = "+972521234567";
const challengeToken = "challenge-token";
const challengeTokenHash = hashBearerToken(challengeToken);

function clone(value) {
  return value === undefined ? undefined : structuredClone(value);
}

function matches(document, filter) {
  return Object.entries(filter).every(([key, expected]) => {
    if (expected && typeof expected === "object" && !(expected instanceof Date)) {
      if (Object.hasOwn(expected, "$gt")) return document[key] > expected.$gt;
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
    this.nextId = 1;
  }

  async createIndex(_keys, options = {}) {
    return options.name;
  }

  async findOne(filter) {
    return clone(this.documents.find((document) => matches(document, filter)) ?? null);
  }

  async findOneAndUpdate(filter, update, options = {}) {
    const index = this.documents.findIndex((document) => matches(document, filter));
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
    phone: storedPhone,
    purpose: "booking",
    challengeTokenHash,
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

function createRealRateStore(clock) {
  const phoneCollection = new MemoryVersionedCollection("phone");
  const sourceCollection = new MemoryVersionedCollection("sourceHash");
  return {
    rateStore: createOtpRateLimitStore({ phoneCollection, sourceCollection, clock }),
    sourceCollection,
  };
}

describe("Twilio-only provider operations", () => {
  beforeEach(() => {
    getTwilioVerifyConfigMock.mockReturnValue({ serviceSid: "service-config-id" });
  });

  it("sends an SMS verification through the configured Twilio service", async () => {
    const create = vi.fn().mockResolvedValue({ status: "pending", sid: "provider-id" });
    const services = vi.fn(() => ({ verifications: { create } }));
    getTwilioClientMock.mockReturnValue({ verify: { v2: { services } } });

    const result = await sendTwilioVerification(storedPhone);

    expect(services).toHaveBeenCalledWith("service-config-id");
    expect(create).toHaveBeenCalledWith({ to: storedPhone, channel: "sms" });
    expect(result).toEqual({ status: "pending", sid: "provider-id" });
  });

  it("verifies a code through Twilio and returns the raw verification check", async () => {
    const create = vi.fn().mockResolvedValue({ status: "approved" });
    const services = vi.fn(() => ({ verificationChecks: { create } }));
    getTwilioClientMock.mockReturnValue({ verify: { v2: { services } } });

    const result = await verifyTwilioCode(storedPhone, "654321");

    expect(create).toHaveBeenCalledWith({ to: storedPhone, code: "654321" });
    expect(result).toEqual({ status: "approved" });
  });

  it.each([500, 501, 599])(
    "classifies HTTP %s verification failures as temporary",
    (status) => {
      expect(classifyTwilioVerifyError({ status, code: 20500 })).toMatchObject({
        errorCode: "OTP_VERIFY_TEMPORARY_FAILURE",
        errorCategory: "PROVIDER_TEMPORARY",
        retryable: true,
      });
    },
  );

  it.each([
    ["fractional", 500.5, "OTP_VERIFY_FAILED"],
    ["below range", 499, "OTP_VERIFY_FAILED"],
    ["above range", 600, "OTP_VERIFY_FAILED"],
    ["rate limit", 429, "OTP_VERIFY_RATE_LIMITED"],
    ["authentication", 401, "OTP_VERIFY_FAILED"],
    ["validation", 400, "INVALID_OTP"],
  ])("does not treat %s HTTP status as a verification 5xx", (_case, status, errorCode) => {
    expect(classifyTwilioVerifyError({ status, code: 20500 })).toMatchObject({
      errorCode,
      retryable: false,
    });
  });

  it.each([500, 501, 599])(
    "classifies HTTP %s send failures as ambiguous without retrying paid sends",
    (status) => {
      expect(classifyTwilioSendError({ status, code: 20500 })).toMatchObject({
        errorCode: "OTP_SEND_PENDING",
        errorCategory: "UNKNOWN_PROVIDER_RESULT",
        retryable: false,
        unknown: true,
      });
    },
  );

  it.each([
    ["fractional", 500.5, "OTP_SEND_FAILED"],
    ["below range", 499, "OTP_SEND_FAILED"],
    ["above range", 600, "OTP_SEND_FAILED"],
    ["rate limit", 429, "OTP_RATE_LIMITED"],
    ["authentication", 401, "TWILIO_AUTH_FAILED"],
    ["validation", 400, "INVALID_PHONE"],
  ])(
    "does not treat %s HTTP status as a send 5xx",
    (_case, status, errorCode) => {
      expect(classifyTwilioSendError({ status, code: 20500 })).toMatchObject({
        errorCode,
        retryable: false,
        unknown: false,
      });
    },
  );

  it("preserves invalid-code verification classification", () => {
    expect(classifyTwilioVerifyError({ status: 404, code: 20404 })).toMatchObject({
      errorCode: "INVALID_OTP",
      retryable: false,
    });
  });
});

describe("requestTwilioFallback", () => {
  let clock;
  let challengeCollection;
  let challengeStore;
  let rateStore;
  let sendVerification;
  let deriveSourceHash;
  let deps;
  let request;
  let validRequest;

  beforeEach(() => {
    clock = createTestClock();
    challengeCollection = new MemoryChallengeCollection();
    challengeCollection.documents.push(activeChallenge());
    challengeStore = createOtpChallengeStore({ collection: challengeCollection });
    rateStore = { claimSourceAction: vi.fn().mockResolvedValue(undefined) };
    sendVerification = vi.fn().mockResolvedValue({
      status: "pending",
      sid: "provider-id",
      body: "provider-body",
      to: storedPhone,
    });
    deriveSourceHash = vi.fn().mockReturnValue("source-hash");
    deps = {
      clock,
      challengeStore,
      rateStore,
      sendVerification,
      deriveSourceHash,
      hashToken: hashBearerToken,
      classifySendError: classifyTwilioSendError,
      env: { NODE_ENV: "test", OTP_SOURCE_HASH_SECRET: "test-secret" },
    };
    request = new Request("https://example.com/api/otp/fallback");
    validRequest = {
      request,
      challengeToken,
      firebaseErrorCode: "auth/internal-error",
    };
  });

  it("uses the stored challenge phone for one approved fallback", async () => {
    const result = await requestTwilioFallback(
      { ...validRequest, phone: "+972599999999" },
      deps,
    );

    expect(sendVerification).toHaveBeenCalledWith(storedPhone);
    expect(result).toEqual({ provider: "twilio", status: "pending" });
    expect(challengeCollection.documents[0]).toMatchObject({
      provider: "twilio",
      status: "twilio_sent",
      fallbackUsed: true,
      providerAttemptCount: 1,
      lastProviderStatus: "pending",
      lastProviderErrorCode: null,
    });
  });

  it.each([
    ["generic", new Error("private detail"), "OTP_SEND_FAILED"],
    ["timeout", { code: "ETIMEDOUT" }, "OTP_SEND_PENDING"],
    ["HTTP 500", { status: 500 }, "OTP_SEND_PENDING"],
    ["HTTP 503", { status: 503 }, "OTP_SEND_PENDING"],
    ["rejection", { status: 400 }, "OTP_PROVIDER_REJECTED"],
    ["provider throttle", { status: 429 }, "OTP_PROVIDER_REJECTED"],
    ["config", { code: "TWILIO_VERIFY_NOT_CONFIGURED" }, "OTP_SERVICE_NOT_CONFIGURED"],
  ])("preserves the active legacy phone deadline on %s failures", async (_label, error, code) => {
    clock.advance(9_000);
    sendVerification.mockRejectedValue(error);
    await expect(requestTwilioFallback(validRequest, deps)).rejects.toMatchObject({
      code, restrictionScope: "phone", retryAfterSeconds: 51,
      retryAt: "2026-08-23T12:01:00.000Z", serverTime: "2026-08-23T12:00:09.000Z",
    });
    expect(sendVerification).toHaveBeenCalledTimes(1);
  });

  it("prefers a stored reservation deadline and correlation ID over challenge creation time", async () => {
    const correlationId = "061a1297-e394-40a2-9e22-fc63b2c186a1";
    challengeCollection.documents[0].correlationId = correlationId;
    challengeCollection.documents[0].retryAt = new Date("2026-08-23T12:00:45.000Z");
    sendVerification.mockRejectedValue(new Error("private detail"));
    clock.advance(9_000);
    await expect(requestTwilioFallback(validRequest, deps)).rejects.toMatchObject({
      correlationId, retryAt: "2026-08-23T12:00:45.000Z", retryAfterSeconds: 36,
    });
  });

  it("does not invent a cooldown after the reservation deadline expires", async () => {
    clock.advance(61_000);
    sendVerification.mockRejectedValue(new Error("private detail"));
    const error = await requestTwilioFallback(validRequest, deps).catch((value) => value);
    expect(error.code).toBe("OTP_SEND_FAILED");
    expect(error).not.toHaveProperty("retryAt");
    expect(error).not.toHaveProperty("retryAfterSeconds");
    expect(error).not.toHaveProperty("restrictionScope");
  });

  it.each(["pending", "rejected"])("reports expiry during a %s dispatch without a false persistence failure", async (outcome) => {
    clock.advance(599_000);
    sendVerification.mockImplementation(async () => {
      clock.advance(2_000);
      if (outcome === "rejected") throw new Error("provider failure");
      return { status: "pending" };
    });
    await expect(requestTwilioFallback(validRequest, deps)).rejects.toMatchObject({ code: "OTP_CHALLENGE_EXPIRED" });
    expect(sendVerification).toHaveBeenCalledTimes(1);
    expect(challengeCollection.documents[0]).toMatchObject({ fallbackUsed: true, status: "twilio_sending" });
    await expect(requestTwilioFallback(validRequest, deps)).rejects.toMatchObject({ code: "OTP_CHALLENGE_EXPIRED" });
    expect(sendVerification).toHaveBeenCalledTimes(1);
  });

  it.each(["pending", "rejected"])("reports replacement during a %s dispatch without overwriting the new challenge", async (outcome) => {
    sendVerification.mockImplementation(async () => {
      await challengeStore.rotate({
        phone: storedPhone, purpose: "booking", challengeTokenHash: "replacement-hash", provider: "firebase",
        now: clock.now(), expiresAt: new Date(clock.now().getTime() + 600_000),
      });
      if (outcome === "rejected") throw new Error("provider failure");
      return { status: "pending" };
    });
    await expect(requestTwilioFallback(validRequest, deps)).rejects.toMatchObject({ code: "OTP_CHALLENGE_FAILED" });
    expect(sendVerification).toHaveBeenCalledTimes(1);
    expect(challengeCollection.documents[0]).toMatchObject({ challengeTokenHash: "replacement-hash", status: "pending", fallbackUsed: false });
  });

  it("keeps the source restriction and the separate phone deadline on source denial", async () => {
    const realRates = createRealRateStore(clock);
    for (let index = 0; index < 3; index += 1) {
      await realRates.rateStore.claimSourceAction("source-hash", "fallback");
    }
    clock.advance(9_000);
    await expect(requestTwilioFallback(validRequest, { ...deps, rateStore: realRates.rateStore })).rejects.toMatchObject({
      code: "OTP_FALLBACK_SOURCE_RATE_LIMITED", restrictionScope: "source",
      retryAt: "2026-08-23T12:10:00.000Z", retryAfterSeconds: 591,
      serverTime: "2026-08-23T12:00:09.000Z", phoneRetryAt: "2026-08-23T12:01:00.000Z",
    });
    expect(sendVerification).not.toHaveBeenCalled();
  });

  it.each(["reserveFallback", "markTwilioFailure", "markTwilioSent"])(
    "reports %s persistence failure safely and retains the active deadline", async (method) => {
      if (method === "markTwilioFailure") sendVerification.mockRejectedValue(new Error("private provider failure"));
      const failingStore = { ...challengeStore, [method]: vi.fn().mockRejectedValue(new Error("private database failure")) };
      await expect(requestTwilioFallback(validRequest, { ...deps, challengeStore: failingStore })).rejects.toMatchObject({
        code: "OTP_PERSISTENCE_FAILED", restrictionScope: "phone", retryAfterSeconds: 60,
        retryAt: "2026-08-23T12:01:00.000Z",
      });
      expect(sendVerification).toHaveBeenCalledTimes(method === "reserveFallback" ? 0 : 1);
      if (method !== "reserveFallback") {
        await expect(requestTwilioFallback(validRequest, deps)).rejects.toMatchObject({ code: "OTP_FALLBACK_ALREADY_USED" });
      }
    },
  );

  it("admits six distinct customers behind one source under a bounded configured policy", async () => {
    const phoneCollection = new MemoryVersionedCollection("phone");
    const sourceCollection = new MemoryVersionedCollection("sourceHash");
    const realRates = createOtpRateLimitStore({
      phoneCollection, sourceCollection, clock,
      env: { OTP_SOURCE_FALLBACK_SHORT_LIMIT: "6" },
    });
    const service = createOtpChallengeService({ ...deps, rateStore: realRates });
    for (let index = 0; index < 7; index += 1) {
      const challenge = await service.create({ request, phone: `052123450${index}`, purpose: "booking" });
      const attempt = requestTwilioFallback({ ...validRequest, challengeToken: challenge.challengeToken }, { ...deps, rateStore: realRates });
      if (index < 6) await expect(attempt).resolves.toMatchObject({ provider: "twilio" });
      else await expect(attempt).rejects.toMatchObject({ code: "OTP_FALLBACK_SOURCE_RATE_LIMITED", restrictionScope: "source" });
    }
    expect(sendVerification).toHaveBeenCalledTimes(6);
    expect(sourceCollection.documents[0].fallbackShortCount).toBe(6);
    await expect(service.create({ request, phone: "0521234500", purpose: "booking" })).rejects.toMatchObject({ code: "OTP_RATE_LIMITED", restrictionScope: "phone" });
  });

  it("emits safe correlated reservation, provider, and failure diagnostics", async () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    const correlationId = "061a1297-e394-40a2-9e22-fc63b2c186a1";
    challengeCollection.documents[0].correlationId = correlationId;
    sendVerification.mockRejectedValue(Object.assign(new Error("private provider detail"), { status: 500, token: "private-token" }));
    await expect(requestTwilioFallback(validRequest, deps)).rejects.toMatchObject({ code: "OTP_SEND_PENDING" });
    const events = info.mock.calls.filter(([message]) => message === "OTP flow").map(([, event]) => event);
    expect(events).toEqual(expect.arrayContaining([
      expect.objectContaining({ correlationId, stage: "fallback", decision: "reserved" }),
      expect.objectContaining({ correlationId, stage: "twilio", decision: "started" }),
      expect.objectContaining({ correlationId, stage: "fallback", decision: "failed", errorCode: "OTP_SEND_PENDING" }),
    ]));
    expect(JSON.stringify(events)).not.toMatch(/private|source-hash|challenge-token|972521234567/);
  });

  it.each([
    "auth/captcha-check-failed",
    "auth/invalid-app-credential",
    "auth/missing-app-credential",
    "auth/network-request-failed",
    "auth/unknown",
  ])("accepts approved Firebase technical failure %s", async (firebaseErrorCode) => {
    await expect(
      requestTwilioFallback({ ...validRequest, firebaseErrorCode }, deps),
    ).resolves.toEqual({ provider: "twilio", status: "pending" });
    expect(sendVerification).toHaveBeenCalledTimes(1);
    expect(challengeCollection.documents[0]).toMatchObject({
      provider: "twilio",
      status: "twilio_sent",
      fallbackUsed: true,
      lastFirebaseErrorCode: firebaseErrorCode,
    });
  });

  it.each([
    "approved",
    "canceled",
    "deleted",
    "expired",
    "failed",
    "max_attempts_reached",
  ])("does not report a terminal Twilio %s response as sent", async (status) => {
    sendVerification.mockResolvedValue({
      status,
      sid: "provider-id",
      to: storedPhone,
    });

    await expect(requestTwilioFallback(validRequest, deps)).rejects.toMatchObject({
      code: "OTP_SEND_FAILED",
      status: 503,
      message: "Failed to send OTP.",
    });
    expect(sendVerification).toHaveBeenCalledTimes(1);
    expect(challengeCollection.documents[0]).toMatchObject({
      provider: "twilio",
      status: "failed",
      fallbackUsed: true,
      providerAttemptCount: 1,
      lastProviderStatus: status,
      lastProviderErrorCode: "OTP_SEND_FAILED",
    });
  });

  it.each([
    ["missing", {}],
    ["unknown", { status: "queued" }],
  ])("records a %s Twilio status as delivery unknown", async (_case, response) => {
    sendVerification.mockResolvedValue({
      ...response,
      sid: "provider-id",
      to: storedPhone,
    });

    await expect(requestTwilioFallback(validRequest, deps)).rejects.toMatchObject({
      code: "OTP_SEND_PENDING",
      status: 503,
      message: "The verification request may still be processing.",
    });
    expect(sendVerification).toHaveBeenCalledTimes(1);
    expect(challengeCollection.documents[0]).toMatchObject({
      provider: "twilio",
      status: "delivery_unknown",
      fallbackUsed: true,
      providerAttemptCount: 1,
      lastProviderStatus: "unknown",
      lastProviderErrorCode: "OTP_SEND_PENDING",
    });
  });

  it("allows only one fallback reservation per challenge", async () => {
    await requestTwilioFallback(validRequest, deps);

    await expect(requestTwilioFallback(validRequest, deps)).rejects.toMatchObject({
      code: "OTP_FALLBACK_ALREADY_USED",
      status: 409,
    });
    expect(sendVerification).toHaveBeenCalledTimes(1);
  });

  it("rejects an impossible direct Twilio state that has no fallback reservation", async () => {
    challengeCollection.documents[0] = activeChallenge({
      provider: "twilio",
      status: "twilio_sending",
      fallbackUsed: false,
    });

    await expect(requestTwilioFallback(validRequest, deps)).rejects.toMatchObject({
      code: "OTP_FALLBACK_NOT_ALLOWED",
      status: 400,
      message: "OTP fallback is not available for this request.",
    });
    expect(rateStore.claimSourceAction).toHaveBeenCalledTimes(1);
    expect(sendVerification).not.toHaveBeenCalled();
  });

  it.each([
    [
      "rotated or missing",
      null,
      {
        code: "OTP_CHALLENGE_FAILED",
        status: 400,
        message: "Invalid or expired OTP challenge.",
      },
    ],
    [
      "expired",
      activeChallenge({ expiresAt: new Date("2026-08-23T12:00:00.000Z") }),
      {
        code: "OTP_CHALLENGE_EXPIRED",
        status: 400,
        message: "Invalid or expired OTP challenge.",
      },
    ],
    [
      "already used",
      activeChallenge({
        provider: "twilio",
        status: "twilio_sending",
        fallbackUsed: true,
      }),
      {
        code: "OTP_FALLBACK_ALREADY_USED",
        status: 409,
        message: "OTP fallback has already been requested.",
      },
    ],
    [
      "otherwise ineligible",
      activeChallenge({
        provider: "development",
        status: "pending",
        fallbackUsed: false,
      }),
      {
        code: "OTP_FALLBACK_NOT_ALLOWED",
        status: 400,
        message: "OTP fallback is not available for this request.",
      },
    ],
  ])("rereads and classifies a %s CAS-loss state", async (_case, fresh, expected) => {
    const findByTokenHash = vi
      .fn()
      .mockResolvedValueOnce(activeChallenge())
      .mockResolvedValueOnce(fresh);
    const raceStore = {
      findByTokenHash,
      reserveFallback: vi.fn().mockResolvedValue(null),
      markTwilioSent: vi.fn(),
      markTwilioFailure: vi.fn(),
    };

    await expect(
      requestTwilioFallback(validRequest, {
        ...deps,
        challengeStore: raceStore,
      }),
    ).rejects.toMatchObject(expected);
    expect(findByTokenHash).toHaveBeenCalledTimes(2);
    expect(raceStore.reserveFallback).toHaveBeenCalledTimes(1);
    expect(sendVerification).not.toHaveBeenCalled();
  });

  it.each([
    "auth/invalid-verification-code",
    "auth/too-many-requests",
    "auth/operation-not-allowed",
    "auth/app-not-authorized",
    "auth/unauthorized-domain",
  ])("rejects unapproved browser report %s without Twilio", async (firebaseErrorCode) => {
    await expect(
      requestTwilioFallback({ ...validRequest, firebaseErrorCode }, deps),
    ).rejects.toMatchObject({ code: "OTP_FALLBACK_NOT_ALLOWED", status: 400 });
    expect(sendVerification).not.toHaveBeenCalled();
  });

  it("rejects a random challenge token before deriving or creating source state", async () => {
    const realRate = createRealRateStore(clock);

    await expect(
      requestTwilioFallback(
        { ...validRequest, challengeToken: "random-token" },
        { ...deps, ...realRate },
      ),
    ).rejects.toMatchObject({ code: "OTP_CHALLENGE_FAILED" });
    expect(deriveSourceHash).not.toHaveBeenCalled();
    expect(realRate.sourceCollection.documents).toHaveLength(0);
  });

  it("claims source capacity before rejecting a valid challenge report", async () => {
    const events = [];
    const orderedStore = {
      findByTokenHash: vi.fn(async () => {
        events.push("find");
        return activeChallenge();
      }),
      reserveFallback: vi.fn(async () => {
        events.push("reserve");
        return activeChallenge({ provider: "twilio", status: "twilio_sending" });
      }),
    };

    await expect(
      requestTwilioFallback(
        { ...validRequest, firebaseErrorCode: "auth/captcha-check-failed" },
        {
          ...deps,
          hashToken: vi.fn(() => {
            events.push("hash");
            return challengeTokenHash;
          }),
          challengeStore: orderedStore,
          deriveSourceHash: vi.fn(() => {
            events.push("derive");
            return "source-hash";
          }),
          rateStore: {
            claimSourceAction: vi.fn(async () => events.push("source")),
          },
          isApprovedFallbackCode: vi.fn(() => {
            events.push("allowlist");
            return false;
          }),
        },
      ),
    ).rejects.toMatchObject({ code: "OTP_FALLBACK_NOT_ALLOWED" });
    expect(events).toEqual(["hash", "find", "derive", "source", "allowlist"]);
  });

  it("rejects the fourth valid-challenge fallback attempt in the short window", async () => {
    const realRate = createRealRateStore(clock);
    const rateDeps = { ...deps, rateStore: realRate.rateStore };
    const rejected = { ...validRequest, firebaseErrorCode: "auth/too-many-requests" };

    for (let attempt = 0; attempt < 3; attempt += 1) {
      await expect(requestTwilioFallback(rejected, rateDeps)).rejects.toMatchObject({
        code: "OTP_FALLBACK_NOT_ALLOWED",
      });
    }

    await expect(requestTwilioFallback(rejected, rateDeps)).rejects.toMatchObject({
      code: "OTP_FALLBACK_SOURCE_RATE_LIMITED",
      status: 429,
      retryAfterSeconds: 600,
    });
    expect(realRate.sourceCollection.documents[0]).toMatchObject({
      fallbackShortCount: 3,
      fallbackHourCount: 3,
    });
  });

  it("shares source fallback limits across challenge phone numbers", async () => {
    const realRate = createRealRateStore(clock);
    const rateDeps = { ...deps, rateStore: realRate.rateStore };

    for (let index = 0; index < 4; index += 1) {
      const token = `challenge-token-${index}`;
      challengeCollection.documents.push(
        activeChallenge({
          _id: index + 2,
          phone: `+97252123456${index}`,
          challengeTokenHash: hashBearerToken(token),
        }),
      );
      const attempt = requestTwilioFallback(
        {
          ...validRequest,
          challengeToken: token,
          firebaseErrorCode: "auth/too-many-requests",
        },
        rateDeps,
      );
      if (index < 3) {
        await expect(attempt).rejects.toMatchObject({ code: "OTP_FALLBACK_NOT_ALLOWED" });
      } else {
        await expect(attempt).rejects.toMatchObject({
          code: "OTP_FALLBACK_SOURCE_RATE_LIMITED",
          status: 429,
        });
      }
    }
  });

  it("enforces the hourly source limit across phones and short-window resets", async () => {
    const realRate = createRealRateStore(clock);
    const rateDeps = { ...deps, rateStore: realRate.rateStore };

    function addDistinctChallenge(index) {
      const token = `hour-challenge-${index}`;
      const now = clock.now();
      challengeCollection.documents.push(
        activeChallenge({
          _id: index + 20,
          phone: `+9725200000${String(index).padStart(2, "0")}`,
          challengeTokenHash: hashBearerToken(token),
          createdAt: now,
          updatedAt: now,
          expiresAt: new Date(now.getTime() + 600_000),
        }),
      );
      return token;
    }

    for (let attempt = 0; attempt < 10; attempt += 1) {
      const token = addDistinctChallenge(attempt);
      await expect(
        requestTwilioFallback(
          {
            ...validRequest,
            challengeToken: token,
            firebaseErrorCode: "auth/too-many-requests",
          },
          rateDeps,
        ),
      ).rejects.toMatchObject({
        code: "OTP_FALLBACK_NOT_ALLOWED",
        status: 400,
      });

      if ((attempt + 1) % 3 === 0 && attempt < 9) {
        clock.advance(600_001);
      }
    }

    const eleventhToken = addDistinctChallenge(10);
    await expect(
      requestTwilioFallback(
        {
          ...validRequest,
          challengeToken: eleventhToken,
          firebaseErrorCode: "auth/too-many-requests",
        },
        rateDeps,
      ),
    ).rejects.toMatchObject({
      code: "OTP_FALLBACK_SOURCE_RATE_LIMITED",
      status: 429,
      retryAfterSeconds: 1800,
    });
    expect(realRate.sourceCollection.documents).toHaveLength(1);
    expect(realRate.sourceCollection.documents[0]).toMatchObject({
      fallbackShortCount: 1,
      fallbackHourCount: 10,
    });
    expect(sendVerification).not.toHaveBeenCalled();
  });

  it("lets one concurrent request reserve and orchestrate the send", async () => {
    let releaseSend;
    sendVerification.mockImplementation(
      () => new Promise((resolve) => {
        releaseSend = resolve;
      }),
    );

    const first = requestTwilioFallback(validRequest, deps);
    const second = requestTwilioFallback(validRequest, deps);
    const settled = Promise.allSettled([first, second]);
    await vi.waitFor(() => expect(sendVerification).toHaveBeenCalledTimes(1));
    releaseSend({ status: "pending", sid: "provider-id" });
    const results = await settled;

    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")[0].reason).toMatchObject({
      code: "OTP_FALLBACK_ALREADY_USED",
    });
    expect(challengeCollection.documents[0]).toMatchObject({
      status: "twilio_sent",
      providerAttemptCount: 1,
    });
  });

  it("makes only one provider invocation even for a clearly pre-delivery failure", async () => {
    sendVerification
      .mockRejectedValueOnce(Object.assign(new Error("name lookup failed"), { code: "ENOTFOUND" }))
      .mockRejectedValueOnce(Object.assign(new Error("connect failed"), { code: "ECONNREFUSED" }))
      .mockResolvedValueOnce({ status: "pending" });

    await expect(requestTwilioFallback(validRequest, deps)).rejects.toMatchObject({ code: "OTP_SEND_FAILED" });
    expect(sendVerification).toHaveBeenCalledTimes(1);
    expect(challengeCollection.documents[0]).toMatchObject({
      status: "failed",
      providerAttemptCount: 1,
    });
  });

  it("makes one invocation under concurrent access even when the provider returns an ambiguous 5xx", async () => {
    const realRates = createRealRateStore(clock);
    sendVerification.mockRejectedValue({ status: 500 });
    const results = await Promise.allSettled(Array.from({ length: 8 }, () =>
      requestTwilioFallback(validRequest, { ...deps, rateStore: realRates.rateStore }),
    ));
    expect(sendVerification).toHaveBeenCalledTimes(1);
    expect(results.every((result) => result.status === "rejected")).toBe(true);
    expect(results.filter((result) => result.reason.code === "OTP_SEND_PENDING")).toHaveLength(1);
    expect(challengeCollection.documents[0]).toMatchObject({
      fallbackUsed: true, status: "delivery_unknown", providerAttemptCount: 1,
    });
    expect(realRates.sourceCollection.documents[0].fallbackShortCount).toBe(3);
  });

  it("retains a real challenge's reservation after provider failure and a nine-second retry", async () => {
    const realRates = createRealRateStore(clock);
    const service = createOtpChallengeService({ ...deps, rateStore: realRates.rateStore });
    const challenge = await service.create({ request, phone: storedPhone, purpose: "booking" });
    sendVerification.mockRejectedValue(new Error("provider failure without retry metadata"));
    await expect(requestTwilioFallback(
      { ...validRequest, challengeToken: challenge.challengeToken },
      { ...deps, rateStore: realRates.rateStore },
    )).rejects.toMatchObject({ code: "OTP_SEND_FAILED", retryAt: challenge.retryAt, correlationId: challenge.correlationId });
    clock.advance(9_000);
    await expect(service.create({ request, phone: storedPhone, purpose: "booking" })).rejects.toMatchObject({
      code: "OTP_RATE_LIMITED", retryAt: challenge.retryAt, retryAfterSeconds: 51, restrictionScope: "phone",
    });
    expect(sendVerification).toHaveBeenCalledTimes(1);
  });

  it("does not retry or replay even a retryable provider failure", async () => {
    sendVerification.mockRejectedValue(Object.assign(new Error("name lookup failed"), { code: "EAI_AGAIN" }));

    await expect(requestTwilioFallback(validRequest, deps)).rejects.toMatchObject({
      code: "OTP_SEND_FAILED",
      status: 503,
    });
    await expect(requestTwilioFallback(validRequest, deps)).rejects.toMatchObject({ code: "OTP_FALLBACK_ALREADY_USED" });
    expect(sendVerification).toHaveBeenCalledTimes(1);
    expect(challengeCollection.documents[0]).toMatchObject({
      status: "failed",
      providerAttemptCount: 1,
      lastProviderStatus: "failed",
      lastProviderErrorCode: "OTP_SEND_FAILED",
    });
  });

  it("does not misclassify a post-send persistence error as provider failure", async () => {
    const markTwilioFailure = vi.fn();
    const storeWithFailedSentTransition = {
      ...challengeStore,
      markTwilioSent: vi.fn().mockRejectedValue(new Error("private database detail")),
      markTwilioFailure,
    };

    await expect(
      requestTwilioFallback(validRequest, {
        ...deps,
        challengeStore: storeWithFailedSentTransition,
      }),
    ).rejects.toMatchObject({ code: "OTP_PERSISTENCE_FAILED", status: 503 });
    expect(sendVerification).toHaveBeenCalledTimes(1);
    expect(markTwilioFailure).not.toHaveBeenCalled();
    expect(challengeCollection.documents[0]).toMatchObject({
      provider: "twilio",
      status: "twilio_sending",
      fallbackUsed: true,
    });
  });

  it.each([
    "ETIMEDOUT",
    "ESOCKETTIMEDOUT",
    "ECONNRESET",
    "EPIPE",
    "UND_ERR_SOCKET",
  ])(
    "does not retry ambiguous %s delivery",
    async (code) => {
      sendVerification.mockRejectedValue(
        Object.assign(new Error("private provider message"), { code }),
      );

      await expect(requestTwilioFallback(validRequest, deps)).rejects.toMatchObject({
        code: "OTP_SEND_PENDING",
        status: 503,
      });
      expect(sendVerification).toHaveBeenCalledTimes(1);
      expect(challengeCollection.documents[0]).toMatchObject({
        status: "delivery_unknown",
        providerAttemptCount: 1,
        lastProviderStatus: "unknown",
        lastProviderErrorCode: "OTP_SEND_PENDING",
      });
    },
  );

  it.each([
    [
      "top-level ETIMEDOUT with HTTP 503",
      Object.assign(new Error("private timeout detail"), {
        status: 503,
        code: "ETIMEDOUT",
      }),
    ],
    [
      "top-level ETIMEDOUT with HTTP 501",
      Object.assign(new Error("private timeout detail"), {
        status: 501,
        code: "ETIMEDOUT",
      }),
    ],
    [
      "top-level ECONNRESET with HTTP 502",
      Object.assign(new Error("private reset detail"), {
        status: 502,
        code: "ECONNRESET",
      }),
    ],
    [
      "nested cause ETIMEDOUT with HTTP 503",
      Object.assign(new Error("private gateway detail"), {
        status: 503,
        code: "WRAPPED_PROVIDER_ERROR",
        cause: Object.assign(new Error("private nested timeout"), {
          code: "ETIMEDOUT",
        }),
      }),
    ],
    [
      "nested response ECONNRESET with HTTP 504",
      Object.assign(new Error("private gateway detail"), {
        status: 504,
        response: {
          code: "ECONNRESET",
          message: "private nested reset",
        },
      }),
    ],
    [
      "nested socket message with HTTP 503",
      Object.assign(new Error("private gateway detail"), {
        status: 503,
        response: { message: "socket hang up after request" },
      }),
    ],
    [
      "nested socket message with HTTP 599",
      Object.assign(new Error("private gateway detail"), {
        status: 599,
        response: { message: "socket hang up after request" },
      }),
    ],
    [
      "top-level ETIMEDOUT message with HTTP 503",
      Object.assign(new Error("request failed with ETIMEDOUT"), {
        status: 503,
      }),
    ],
    [
      "nested ECONNRESET message with HTTP 504",
      Object.assign(new Error("private gateway detail"), {
        status: 504,
        cause: { message: "read ECONNRESET after request" },
      }),
    ],
  ])("prioritizes ambiguous delivery for %s", async (_case, error) => {
    expect(classifyTwilioSendError(error)).toMatchObject({
      errorCode: "OTP_SEND_PENDING",
      retryable: false,
      unknown: true,
    });
    sendVerification.mockRejectedValue(error);

    await expect(requestTwilioFallback(validRequest, deps)).rejects.toMatchObject({
      code: "OTP_SEND_PENDING",
      status: 503,
    });
    expect(sendVerification).toHaveBeenCalledTimes(1);
    expect(challengeCollection.documents[0]).toMatchObject({
      status: "delivery_unknown",
      providerAttemptCount: 1,
      lastProviderStatus: "unknown",
      lastProviderErrorCode: "OTP_SEND_PENDING",
    });
  });

  it.each([
    ["permanent", Object.assign(new Error("private invalid request"), { status: 400 }), "OTP_PROVIDER_REJECTED"],
    [
      "configuration",
      Object.assign(new Error("private credentials detail"), {
        code: "TWILIO_VERIFY_NOT_CONFIGURED",
      }),
      "OTP_SERVICE_NOT_CONFIGURED",
    ],
  ])("makes one call and records %s failures", async (_kind, error, publicCode) => {
    sendVerification.mockRejectedValue(error);

    await expect(requestTwilioFallback(validRequest, deps)).rejects.toMatchObject({
      code: publicCode,
    });
    expect(sendVerification).toHaveBeenCalledTimes(1);
    expect(challengeCollection.documents[0]).toMatchObject({
      status: "failed",
      providerAttemptCount: 1,
      lastProviderStatus: "failed",
      lastProviderErrorCode: publicCode,
    });
  });

  it("persists only bounded aggregate provider summaries", async () => {
    const rawError = Object.assign(new Error("raw provider message with private detail"), {
      code: "ETIMEDOUT",
      sid: "provider-secret-id",
      body: { detail: "provider-secret-body" },
      phone: "+972599999999",
    });
    sendVerification.mockRejectedValue(rawError);

    await expect(requestTwilioFallback(validRequest, deps)).rejects.toMatchObject({
      code: "OTP_SEND_PENDING",
    });

    const stored = challengeCollection.documents[0];
    expect(stored).toMatchObject({
      providerAttemptCount: 1,
      lastProviderStatus: "unknown",
      lastProviderErrorCode: "OTP_SEND_PENDING",
    });
    expect(Object.keys(stored)).not.toEqual(
      expect.arrayContaining(["sid", "body", "error", "exception", "providerMessage"]),
    );
    expect(JSON.stringify(stored)).not.toMatch(
      /raw provider message|private detail|provider-secret-id|provider-secret-body|\+972599999999/,
    );
  });
});
