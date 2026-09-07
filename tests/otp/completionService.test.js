import { beforeEach, describe, expect, it, vi } from "vitest";
import { verifyFirebaseEvidence as verifyFirebaseEvidenceContract } from "@/lib/otp/firebaseEvidence";
import { completeOtpChallenge } from "@/lib/otp/completionService";
import { createOtpRateLimitStore } from "@/lib/otp/rateLimitStore";
import {
  createTestClock,
  MemoryMongoCollection,
  MemoryVersionedCollection,
} from "../helpers/memoryOtpStores";

const { getProductionChallengeStore, productionChallengeStore } = vi.hoisted(
  () => {
    const store = { findByTokenHash: vi.fn() };
    return {
      productionChallengeStore: store,
      getProductionChallengeStore: vi.fn().mockResolvedValue(store),
    };
  },
);

vi.mock("@/lib/otp/challengeStore", () => ({
  getOtpChallengeStore: getProductionChallengeStore,
}));

const NOW = new Date("2026-08-23T12:00:00.000Z");
const CHALLENGE_TOKEN_HASH = "hashed-challenge-token";
const STORED_PHONE = "+972501234567";

function activeChallenge(overrides = {}) {
  return {
    _id: "challenge-id",
    challengeTokenHash: CHALLENGE_TOKEN_HASH,
    phone: STORED_PHONE,
    purpose: "booking",
    provider: "firebase",
    status: "pending",
    createdAt: new Date(NOW.getTime() - 60_000),
    expiresAt: new Date(NOW.getTime() + 300_000),
    ...overrides,
  };
}

function createDeps(challenge = activeChallenge(), overrides = {}) {
  const deps = {
    clock: { now: vi.fn(() => new Date(NOW)) },
    hashChallengeToken: vi.fn(() => CHALLENGE_TOKEN_HASH),
    challengeStore: {
      findByTokenHash: vi.fn().mockResolvedValue(challenge),
      completeLogin: vi.fn().mockResolvedValue(
        challenge
          ? {
              ...challenge,
              status: "completed",
              completedAt: NOW,
              updatedAt: NOW,
            }
          : null,
      ),
    },
    verifyFirebaseEvidence: vi.fn().mockResolvedValue(STORED_PHONE),
    verifyTwilioCode: vi.fn().mockResolvedValue({ status: "approved" }),
    classifyTwilioVerifyError: vi.fn(),
    verifyAttemptIdFactory: vi.fn(() => "verify-attempt-id"),
    rateLimitStore: {
      reservePhoneVerifyAttempt: vi.fn().mockResolvedValue({
        verifyFailureCount: 1,
        blockedUntil: null,
      }),
      releasePhoneVerifyAttempt: vi.fn().mockResolvedValue({ released: true }),
      getPhoneVerifyLimit: vi.fn().mockResolvedValue({ remainingFailures: 5 }),
      recordPhoneVerifyFailure: vi.fn().mockResolvedValue({
        verifyFailureCount: 1,
        blockedUntil: null,
      }),
      clearPhoneVerifyFailures: vi.fn().mockResolvedValue(undefined),
    },
    usersData: {
      findOne: vi.fn().mockResolvedValue({
        firstName: "  Ada ",
        lastName: " Lovelace  ",
      }),
    },
    issueBookingGrant: vi.fn().mockResolvedValue({
      verificationToken: "one-time-booking-grant",
    }),
    signCustomerSession: vi.fn().mockResolvedValue("candidate-session-token"),
    env: {
      NODE_ENV: "test",
      OTP_DEV_CODE: "654321",
    },
    logger: {
      error: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
    },
    ...overrides,
  };

  return deps;
}

function persistedAndLoggedCalls(deps) {
  return [
    ...deps.challengeStore.findByTokenHash.mock.calls,
    ...deps.challengeStore.completeLogin.mock.calls,
    ...deps.rateLimitStore.getPhoneVerifyLimit.mock.calls,
    ...deps.rateLimitStore.reservePhoneVerifyAttempt.mock.calls,
    ...deps.rateLimitStore.releasePhoneVerifyAttempt.mock.calls,
    ...deps.rateLimitStore.recordPhoneVerifyFailure.mock.calls,
    ...deps.rateLimitStore.clearPhoneVerifyFailures.mock.calls,
    ...deps.usersData.findOne.mock.calls,
    ...deps.issueBookingGrant.mock.calls,
    ...deps.logger.error.mock.calls,
    ...deps.logger.info.mock.calls,
    ...deps.logger.warn.mock.calls,
  ];
}

async function expectOtpError(promise, code, status) {
  await expect(promise).rejects.toMatchObject({ code, status });
}

async function captureExpectedError(operation) {
  try {
    await operation();
  } catch (error) {
    return error;
  }
  throw new Error("Expected operation to reject.");
}

async function createProductionChallengeStore(challenge) {
  const { createOtpChallengeStore } = await vi.importActual(
    "@/lib/otp/challengeStore",
  );
  const collection = new MemoryMongoCollection([challenge]);
  return {
    challengeStore: createOtpChallengeStore({ collection }),
    collection,
  };
}

describe("completeOtpChallenge Firebase completion", () => {
  it("uses Firebase evidence and only the stored challenge phone and purpose", async () => {
    const challenge = activeChallenge();
    const deps = createDeps(challenge);

    const result = await completeOtpChallenge(
      {
        challengeToken: "challenge-token",
        provider: "firebase",
        idToken: "transient-id-token",
        phone: "+972599999999",
        purpose: "login",
      },
      deps,
    );

    expect(deps.hashChallengeToken).toHaveBeenCalledWith("challenge-token");
    expect(deps.challengeStore.findByTokenHash).toHaveBeenCalledWith(
      CHALLENGE_TOKEN_HASH,
    );
    expect(deps.verifyFirebaseEvidence).toHaveBeenCalledWith({
      idToken: "transient-id-token",
      challenge,
      now: NOW,
    });
    expect(deps.usersData.findOne).toHaveBeenCalledWith(
      { phone: STORED_PHONE },
      { projection: { firstName: 1, lastName: 1 } },
    );
    expect(deps.issueBookingGrant).toHaveBeenCalledWith({
      challenge,
      challengeTokenHash: CHALLENGE_TOKEN_HASH,
    });
    expect(result).toEqual({
      success: true,
      purpose: "booking",
      verificationToken: "one-time-booking-grant",
      expiresInSeconds: 600,
      profile: {
        hasCompleteName: true,
        firstName: "Ada",
        lastName: "Lovelace",
      },
    });
    expect(JSON.stringify(persistedAndLoggedCalls(deps))).not.toContain(
      "transient-id-token",
    );
  });

  it("accepts valid Firebase phone evidence", async () => {
    const challenge = activeChallenge();
    const adminAuth = {
      verifyIdToken: vi.fn().mockResolvedValue({
        phone_number: STORED_PHONE,
        auth_time: NOW.getTime() / 1_000,
        firebase: { sign_in_provider: "phone" },
      }),
    };
    const deps = createDeps(challenge, {
      verifyFirebaseEvidence: (input) =>
        verifyFirebaseEvidenceContract(input, { adminAuth }),
    });

    await expect(
      completeOtpChallenge(
        {
          challengeToken: "challenge-token",
          provider: "firebase",
          idToken: "valid-id-token",
        },
        deps,
      ),
    ).resolves.toMatchObject({ success: true, purpose: "booking" });
  });

  it.each([
    ["invalid token", () => Promise.reject(new Error("rejected"))],
    [
      "wrong token phone",
      () =>
        Promise.resolve({
          phone_number: "+972509999999",
          auth_time: NOW.getTime() / 1_000,
          firebase: { sign_in_provider: "phone" },
        }),
    ],
    [
      "non-phone provider",
      () =>
        Promise.resolve({
          phone_number: STORED_PHONE,
          auth_time: NOW.getTime() / 1_000,
          firebase: { sign_in_provider: "password" },
        }),
    ],
    [
      "stale authentication",
      () =>
        Promise.resolve({
          phone_number: STORED_PHONE,
          auth_time: (NOW.getTime() - 181_000) / 1_000,
          firebase: { sign_in_provider: "phone" },
        }),
    ],
    [
      "future authentication",
      () =>
        Promise.resolve({
          phone_number: STORED_PHONE,
          auth_time: (NOW.getTime() + 121_000) / 1_000,
          firebase: { sign_in_provider: "phone" },
        }),
    ],
  ])("rejects %s Firebase evidence without completing", async (_name, verify) => {
    const challenge = activeChallenge();
    const adminAuth = { verifyIdToken: vi.fn().mockImplementation(verify) };
    const deps = createDeps(challenge, {
      verifyFirebaseEvidence: (input) =>
        verifyFirebaseEvidenceContract(input, { adminAuth }),
    });

    await expectOtpError(
      completeOtpChallenge(
        {
          challengeToken: "challenge-token",
          provider: "firebase",
          idToken: "untrusted-id-token",
        },
        deps,
      ),
      "INVALID_FIREBASE_TOKEN",
      401,
    );
    expect(deps.usersData.findOne).not.toHaveBeenCalled();
    expect(deps.issueBookingGrant).not.toHaveBeenCalled();
  });
});

describe("completeOtpChallenge stored challenge validation", () => {
  it("awaits the production challenge-store resolver before lookup", async () => {
    const challenge = activeChallenge();
    productionChallengeStore.findByTokenHash.mockResolvedValueOnce(challenge);
    const deps = createDeps(challenge);
    delete deps.challengeStore;

    await expect(
      completeOtpChallenge(
        {
          challengeToken: "challenge-token",
          provider: "firebase",
          idToken: "transient-id-token",
        },
        deps,
      ),
    ).resolves.toMatchObject({ success: true, purpose: "booking" });
    expect(getProductionChallengeStore).toHaveBeenCalledTimes(1);
    expect(productionChallengeStore.findByTokenHash).toHaveBeenCalledWith(
      CHALLENGE_TOKEN_HASH,
    );
  });

  it.each([
    [null, "OTP_VERIFICATION_INVALID", 401],
    [activeChallenge({ phone: "" }), "OTP_VERIFICATION_INVALID", 401],
    [
      activeChallenge({ expiresAt: new Date(NOW.getTime() - 1) }),
      "OTP_VERIFICATION_EXPIRED",
      401,
    ],
    [activeChallenge({ status: "completed" }), "OTP_CHALLENGE_ALREADY_COMPLETED", 409],
    [activeChallenge({ status: "completing" }), "OTP_COMPLETION_IN_PROGRESS", 409],
    [activeChallenge({ status: "failed" }), "OTP_VERIFICATION_INVALID", 401],
    [activeChallenge({ status: "delivery_unknown" }), "OTP_VERIFICATION_INVALID", 401],
    [activeChallenge({ status: "twilio_sent" }), "OTP_VERIFICATION_INVALID", 401],
  ])("rejects an unusable stored challenge before evidence", async (challenge, code, status) => {
    const deps = createDeps(challenge);

    await expectOtpError(
      completeOtpChallenge(
        {
          challengeToken: "challenge-token",
          provider: "firebase",
          idToken: "transient-id-token",
        },
        deps,
      ),
      code,
      status,
    );
    expect(deps.verifyFirebaseEvidence).not.toHaveBeenCalled();
    expect(deps.rateLimitStore.getPhoneVerifyLimit).not.toHaveBeenCalled();
    expect(deps.usersData.findOne).not.toHaveBeenCalled();
    expect(deps.issueBookingGrant).not.toHaveBeenCalled();
  });

  it("rejects payload/stored provider mismatch before evidence", async () => {
    const deps = createDeps(activeChallenge({ provider: "twilio", status: "twilio_sent" }));

    await expectOtpError(
      completeOtpChallenge(
        {
          challengeToken: "challenge-token",
          provider: "firebase",
          idToken: "transient-id-token",
        },
        deps,
      ),
      "OTP_PROVIDER_MISMATCH",
      400,
    );
    expect(deps.verifyFirebaseEvidence).not.toHaveBeenCalled();
    expect(deps.rateLimitStore.getPhoneVerifyLimit).not.toHaveBeenCalled();
    expect(deps.issueBookingGrant).not.toHaveBeenCalled();
  });

  it.each([
    [{ provider: "firebase", idToken: "" }, "OTP_EVIDENCE_REQUIRED"],
    [{ provider: "twilio", code: "" }, "OTP_EVIDENCE_REQUIRED"],
    [{ provider: "development", code: null }, "OTP_EVIDENCE_REQUIRED"],
  ])("rejects malformed provider evidence", async (payloadEvidence, code) => {
    const provider = payloadEvidence.provider;
    const status = provider === "twilio" ? "twilio_sent" : "pending";
    const deps = createDeps(activeChallenge({ provider, status }));

    await expectOtpError(
      completeOtpChallenge(
        { challengeToken: "challenge-token", ...payloadEvidence },
        deps,
      ),
      code,
      400,
    );
    expect(deps.rateLimitStore.recordPhoneVerifyFailure).not.toHaveBeenCalled();
    expect(deps.issueBookingGrant).not.toHaveBeenCalled();
  });
});

describe("completeOtpChallenge Twilio completion", () => {
  let challenge;

  beforeEach(() => {
    challenge = activeChallenge({ provider: "twilio", status: "twilio_sent" });
  });

  it("admits at most five blocked parallel calls across the Twilio boundary", async () => {
    const clock = createTestClock(NOW);
    const phoneCollection = new MemoryVersionedCollection("phone");
    const sourceCollection = new MemoryVersionedCollection("sourceHash");
    const rateLimitStore = createOtpRateLimitStore({
      phoneCollection,
      sourceCollection,
      clock,
    });
    let releaseProvider;
    const providerGate = new Promise((resolve) => {
      releaseProvider = resolve;
    });
    const verifyTwilioCode = vi.fn(() => providerGate);
    let nextAttemptId = 0;
    const deps = createDeps(challenge, {
      rateLimitStore,
      verifyTwilioCode,
      verifyAttemptIdFactory: () => `parallel-attempt-${++nextAttemptId}`,
    });

    const calls = Array.from({ length: 6 }, (_, index) =>
      completeOtpChallenge(
        {
          challengeToken: "challenge-token",
          provider: "twilio",
          code: `00000${index}`,
        },
        deps,
      ),
    );
    const outcomesPromise = Promise.allSettled(calls);

    while (verifyTwilioCode.mock.calls.length < 5) {
      await new Promise((resolve) => setImmediate(resolve));
    }
    await new Promise((resolve) => setImmediate(resolve));
    const callsBeforeProviderRelease = verifyTwilioCode.mock.calls.length;
    releaseProvider({ status: "pending" });
    const outcomes = await outcomesPromise;

    expect(callsBeforeProviderRelease).toBe(5);
    expect(verifyTwilioCode).toHaveBeenCalledTimes(5);
    expect(
      outcomes.filter(
        (outcome) =>
          outcome.status === "rejected" &&
          outcome.reason?.code === "OTP_VERIFY_RATE_LIMITED",
      ),
    ).toHaveLength(2);
    expect(phoneCollection.documents[0]).toMatchObject({
      verifyFailureCount: 5,
      version: 5,
    });
  });

  it("retains its owned reservation after a technical provider failure", async () => {
    const clock = createTestClock(NOW);
    const phoneCollection = new MemoryVersionedCollection("phone");
    const sourceCollection = new MemoryVersionedCollection("sourceHash");
    const rateLimitStore = createOtpRateLimitStore({
      phoneCollection,
      sourceCollection,
      clock,
    });
    const providerError = Object.assign(new Error("provider unavailable"), {
      status: 503,
    });
    const deps = createDeps(challenge, {
      rateLimitStore,
      verifyAttemptIdFactory: () => "technical-attempt",
      verifyTwilioCode: vi.fn().mockRejectedValue(providerError),
      classifyTwilioVerifyError: vi.fn().mockReturnValue({
        errorCode: "OTP_VERIFY_TEMPORARY_FAILURE",
      }),
    });

    await expectOtpError(
      completeOtpChallenge(
        {
          challengeToken: "challenge-token",
          provider: "twilio",
          code: "123123",
        },
        deps,
      ),
      "OTP_VERIFY_TEMPORARY_FAILURE",
      503,
    );

    expect(phoneCollection.documents[0]).toMatchObject({
      verifyFailureCount: 1,
      verifyReservationIds: ["technical-attempt"],
      version: 1,
    });
  });

  it("counts five ambiguous provider failures and blocks a sixth provider call", async () => {
    const clock = createTestClock(NOW);
    const phoneCollection = new MemoryVersionedCollection("phone");
    const sourceCollection = new MemoryVersionedCollection("sourceHash");
    const rateLimitStore = createOtpRateLimitStore({
      phoneCollection,
      sourceCollection,
      clock,
    });
    const ambiguousFailures = [
      Object.assign(new Error("timeout detail"), { code: "ETIMEDOUT" }),
      Object.assign(new Error("reset detail"), { code: "ECONNRESET" }),
      Object.assign(new Error("server detail"), { status: 500, code: 20500 }),
      Object.assign(new Error("gateway detail"), { status: 503, code: 20503 }),
      new Error("unknown provider detail"),
    ];
    const verifyTwilioCode = vi
      .fn()
      .mockRejectedValueOnce(ambiguousFailures[0])
      .mockRejectedValueOnce(ambiguousFailures[1])
      .mockRejectedValueOnce(ambiguousFailures[2])
      .mockRejectedValueOnce(ambiguousFailures[3])
      .mockRejectedValueOnce(ambiguousFailures[4])
      .mockResolvedValueOnce({ status: "approved" });
    let nextAttemptId = 0;
    const deps = createDeps(challenge, {
      rateLimitStore,
      verifyTwilioCode,
      verifyAttemptIdFactory: () => `ambiguous-attempt-${++nextAttemptId}`,
    });
    delete deps.classifyTwilioVerifyError;

    for (let index = 0; index < ambiguousFailures.length; index += 1) {
      await expect(
        completeOtpChallenge(
          {
            challengeToken: "challenge-token",
            provider: "twilio",
            code: `10000${index}`,
          },
          deps,
        ),
      ).rejects.toMatchObject({ status: 503 });
    }

    await expectOtpError(
      completeOtpChallenge(
        {
          challengeToken: "challenge-token",
          provider: "twilio",
          code: "100005",
        },
        deps,
      ),
      "OTP_VERIFY_RATE_LIMITED",
      429,
    );

    expect(verifyTwilioCode).toHaveBeenCalledTimes(5);
    expect(phoneCollection.documents[0]).toMatchObject({
      verifyFailureCount: 5,
      verifyReservationIds: [
        "ambiguous-attempt-1",
        "ambiguous-attempt-2",
        "ambiguous-attempt-3",
        "ambiguous-attempt-4",
        "ambiguous-attempt-5",
      ],
      version: 5,
    });
  });

  it("reserves before verifying only the stored phone and clears after completion", async () => {
    const deps = createDeps(challenge);

    await completeOtpChallenge(
      {
        challengeToken: "challenge-token",
        provider: "twilio",
        code: "123123",
        phone: "+972599999999",
        purpose: "login",
      },
      deps,
    );

    expect(deps.rateLimitStore.reservePhoneVerifyAttempt).toHaveBeenCalledWith(
      STORED_PHONE,
      "verify-attempt-id",
    );
    expect(deps.rateLimitStore.getPhoneVerifyLimit).not.toHaveBeenCalled();
    expect(deps.verifyTwilioCode).toHaveBeenCalledWith(STORED_PHONE, "123123");
    expect(deps.rateLimitStore.clearPhoneVerifyFailures).toHaveBeenCalledWith(
      STORED_PHONE,
    );
    expect(deps.rateLimitStore.recordPhoneVerifyFailure).not.toHaveBeenCalled();
  });

  it.each(["pending", "canceled"])(
    "keeps exactly one reserved attempt for non-approved status %s",
    async (providerStatus) => {
      const deps = createDeps(challenge, {
        verifyTwilioCode: vi.fn().mockResolvedValue({ status: providerStatus }),
      });

      await expectOtpError(
        completeOtpChallenge(
          {
            challengeToken: "challenge-token",
            provider: "twilio",
            code: "000000",
          },
          deps,
        ),
        "INVALID_OTP",
        401,
      );
      expect(deps.rateLimitStore.reservePhoneVerifyAttempt).toHaveBeenCalledWith(
        STORED_PHONE,
        "verify-attempt-id",
      );
      expect(deps.rateLimitStore.recordPhoneVerifyFailure).not.toHaveBeenCalled();
      expect(deps.rateLimitStore.releasePhoneVerifyAttempt).not.toHaveBeenCalled();
      expect(deps.rateLimitStore.clearPhoneVerifyFailures).not.toHaveBeenCalled();
      expect(deps.issueBookingGrant).not.toHaveBeenCalled();
    },
  );

  it("keeps exactly one reserved attempt for a provider invalid-code error", async () => {
    const providerError = Object.assign(new Error("provider detail"), {
      status: 400,
      code: 60202,
    });
    const deps = createDeps(challenge, {
      verifyTwilioCode: vi.fn().mockRejectedValue(providerError),
      classifyTwilioVerifyError: vi.fn().mockReturnValue({
        errorCode: "INVALID_OTP",
        errorCategory: "PROVIDER_VALIDATION",
        retryable: false,
        unknown: false,
        providerHttpStatus: 400,
        providerErrorCode: 60202,
      }),
    });

    await expectOtpError(
      completeOtpChallenge(
        {
          challengeToken: "challenge-token",
          provider: "twilio",
          code: "000000",
        },
        deps,
      ),
      "INVALID_OTP",
      401,
    );
    expect(deps.rateLimitStore.reservePhoneVerifyAttempt).toHaveBeenCalledWith(
      STORED_PHONE,
      "verify-attempt-id",
    );
    expect(deps.rateLimitStore.recordPhoneVerifyFailure).not.toHaveBeenCalled();
    expect(deps.rateLimitStore.releasePhoneVerifyAttempt).not.toHaveBeenCalled();
    expect(deps.issueBookingGrant).not.toHaveBeenCalled();
    expect(JSON.stringify(persistedAndLoggedCalls(deps))).not.toContain("60202");
    expect(JSON.stringify(persistedAndLoggedCalls(deps))).not.toContain(
      "provider detail",
    );
  });

  it("returns rate limited when the fifth reserved attempt is invalid", async () => {
    const deps = createDeps(challenge, {
      verifyTwilioCode: vi.fn().mockResolvedValue({ status: "pending" }),
    });
    deps.rateLimitStore.reservePhoneVerifyAttempt.mockResolvedValue({
      verifyFailureCount: 5,
      blockedUntil: new Date(NOW.getTime() + 300_000),
    });

    await expectOtpError(
      completeOtpChallenge(
        {
          challengeToken: "challenge-token",
          provider: "twilio",
          code: "000000",
        },
        deps,
      ),
      "OTP_VERIFY_RATE_LIMITED",
      429,
    );
    expect(deps.rateLimitStore.reservePhoneVerifyAttempt).toHaveBeenCalledTimes(1);
    expect(deps.rateLimitStore.recordPhoneVerifyFailure).not.toHaveBeenCalled();
  });

  it("returns rate limited before provider verification after five failures", async () => {
    const rateError = Object.assign(new Error("bounded"), {
      code: "OTP_VERIFY_RATE_LIMITED",
      status: 429,
      retryAfter: 240,
    });
    const deps = createDeps(challenge);
    deps.rateLimitStore.reservePhoneVerifyAttempt.mockRejectedValue(rateError);

    await expectOtpError(
      completeOtpChallenge(
        {
          challengeToken: "challenge-token",
          provider: "twilio",
          code: "000000",
        },
        deps,
      ),
      "OTP_VERIFY_RATE_LIMITED",
      429,
    );
    expect(deps.verifyTwilioCode).not.toHaveBeenCalled();
    expect(deps.rateLimitStore.reservePhoneVerifyAttempt).toHaveBeenCalledWith(
      STORED_PHONE,
      "verify-attempt-id",
    );
    expect(deps.rateLimitStore.getPhoneVerifyLimit).not.toHaveBeenCalled();
    expect(deps.rateLimitStore.recordPhoneVerifyFailure).not.toHaveBeenCalled();
    expect(deps.rateLimitStore.releasePhoneVerifyAttempt).not.toHaveBeenCalled();
  });

  it.each([
    ["HTTP 500", { status: 500, code: 20500 }],
    ["HTTP 501", { status: 501, code: 20501 }],
    ["HTTP 599", { status: 599, code: 20599 }],
    ["timeout", { code: "ETIMEDOUT" }],
  ])("uses the real classifier for %s without send or fallback", async (_name, shape) => {
    const rawDetail = "raw provider outage detail";
    const providerError = Object.assign(new Error(rawDetail), shape);
    const sendTwilioVerification = vi.fn();
    const reserveFallback = vi.fn();
    const challengeBefore = structuredClone(challenge);
    const deps = createDeps(challenge, {
      verifyTwilioCode: vi.fn().mockRejectedValue(providerError),
      sendTwilioVerification,
      reserveFallback,
    });
    delete deps.classifyTwilioVerifyError;

    let completionError;
    try {
      await completeOtpChallenge(
        {
          challengeToken: "challenge-token",
          provider: "twilio",
          code: "123123",
        },
        deps,
      );
    } catch (error) {
      completionError = error;
    }

    expect(completionError).toMatchObject({
      code: "OTP_VERIFY_TEMPORARY_FAILURE",
      status: 503,
      message: "OTP verification is temporarily unavailable.",
    });
    expect(
      JSON.stringify({ ...completionError, message: completionError?.message }),
    ).not.toContain(rawDetail);
    expect(deps.rateLimitStore.recordPhoneVerifyFailure).not.toHaveBeenCalled();
    expect(deps.rateLimitStore.releasePhoneVerifyAttempt).not.toHaveBeenCalled();
    expect(deps.rateLimitStore.clearPhoneVerifyFailures).not.toHaveBeenCalled();
    expect(sendTwilioVerification).not.toHaveBeenCalled();
    expect(reserveFallback).not.toHaveBeenCalled();
    expect(deps.usersData.findOne).not.toHaveBeenCalled();
    expect(deps.issueBookingGrant).not.toHaveBeenCalled();
    expect(deps.logger.error).not.toHaveBeenCalled();
    expect(deps.logger.info).not.toHaveBeenCalled();
    expect(deps.logger.warn).not.toHaveBeenCalled();
    expect(challenge).toEqual(challengeBefore);
  });
});

describe("completeOtpChallenge development completion", () => {
  it("requires explicit matching development code outside production", async () => {
    const challenge = activeChallenge({ provider: "development" });
    const deps = createDeps(challenge);

    await completeOtpChallenge(
      {
        challengeToken: "challenge-token",
        provider: "development",
        code: "654321",
      },
      deps,
    );

    expect(deps.rateLimitStore.getPhoneVerifyLimit).toHaveBeenCalledWith(
      STORED_PHONE,
    );
    expect(deps.rateLimitStore.clearPhoneVerifyFailures).toHaveBeenCalledWith(
      STORED_PHONE,
    );
    expect(deps.rateLimitStore.recordPhoneVerifyFailure).not.toHaveBeenCalled();
  });

  it.each([
    [{ NODE_ENV: "test", OTP_DEV_CODE: "" }, "654321"],
    [{ NODE_ENV: "test" }, "123456"],
    [{ NODE_ENV: "test", OTP_DEV_CODE: "   " }, "123456"],
  ])("rejects absent or blank explicit configuration without a default", async (env, code) => {
    const deps = createDeps(activeChallenge({ provider: "development" }), { env });

    await expectOtpError(
      completeOtpChallenge(
        { challengeToken: "challenge-token", provider: "development", code },
        deps,
      ),
      "OTP_DEVELOPMENT_COMPLETION_UNAVAILABLE",
      503,
    );
    expect(deps.rateLimitStore.getPhoneVerifyLimit).not.toHaveBeenCalled();
    expect(deps.rateLimitStore.recordPhoneVerifyFailure).not.toHaveBeenCalled();
    expect(deps.issueBookingGrant).not.toHaveBeenCalled();
  });

  it("records one bounded failure for a wrong development code", async () => {
    const deps = createDeps(activeChallenge({ provider: "development" }));

    await expectOtpError(
      completeOtpChallenge(
        {
          challengeToken: "challenge-token",
          provider: "development",
          code: "123456",
        },
        deps,
      ),
      "INVALID_OTP",
      401,
    );
    expect(deps.rateLimitStore.recordPhoneVerifyFailure).toHaveBeenCalledTimes(1);
    expect(deps.rateLimitStore.recordPhoneVerifyFailure).toHaveBeenCalledWith(
      STORED_PHONE,
    );
    expect(deps.issueBookingGrant).not.toHaveBeenCalled();
  });

  it("rejects development in production without any state transition", async () => {
    const deps = createDeps(activeChallenge({ provider: "development" }), {
      env: { NODE_ENV: "production", OTP_DEV_CODE: "654321" },
    });

    await expectOtpError(
      completeOtpChallenge(
        {
          challengeToken: "challenge-token",
          provider: "development",
          code: "654321",
        },
        deps,
      ),
      "OTP_DEVELOPMENT_COMPLETION_UNAVAILABLE",
      503,
    );
    expect(deps.rateLimitStore.getPhoneVerifyLimit).not.toHaveBeenCalled();
    expect(deps.rateLimitStore.recordPhoneVerifyFailure).not.toHaveBeenCalled();
    expect(deps.rateLimitStore.clearPhoneVerifyFailures).not.toHaveBeenCalled();
    expect(deps.usersData.findOne).not.toHaveBeenCalled();
    expect(deps.issueBookingGrant).not.toHaveBeenCalled();
  });

  it("rejects development in production before inspecting missing evidence", async () => {
    const deps = createDeps(activeChallenge({ provider: "development" }), {
      env: { NODE_ENV: "production", OTP_DEV_CODE: "654321" },
    });

    await expectOtpError(
      completeOtpChallenge(
        {
          challengeToken: "challenge-token",
          provider: "development",
        },
        deps,
      ),
      "OTP_DEVELOPMENT_COMPLETION_UNAVAILABLE",
      503,
    );
    expect(deps.rateLimitStore.getPhoneVerifyLimit).not.toHaveBeenCalled();
    expect(deps.rateLimitStore.recordPhoneVerifyFailure).not.toHaveBeenCalled();
    expect(deps.usersData.findOne).not.toHaveBeenCalled();
    expect(deps.issueBookingGrant).not.toHaveBeenCalled();
  });
});

describe("completeOtpChallenge purpose and profile handling", () => {
  it("signs login before conditional completion without booking side effects", async () => {
    const challenge = activeChallenge({ purpose: "login" });
    const deps = createDeps(challenge);

    const result = await completeOtpChallenge(
      {
        challengeToken: "challenge-token",
        provider: "firebase",
        idToken: "transient-id-token",
      },
      deps,
    );

    expect(deps.verifyFirebaseEvidence).toHaveBeenCalledWith({
      idToken: "transient-id-token",
      challenge,
      now: NOW,
    });
    expect(deps.signCustomerSession).toHaveBeenCalledWith(
      STORED_PHONE,
      expect.objectContaining({ now: NOW, ttlSeconds: 3_600 }),
    );
    expect(deps.challengeStore.completeLogin).toHaveBeenCalledWith({
      challengeId: challenge._id,
      challengeTokenHash: CHALLENGE_TOKEN_HASH,
      purpose: "login",
      provider: "firebase",
      eligibleStatus: "pending",
      now: NOW,
    });
    expect(deps.verifyFirebaseEvidence.mock.invocationCallOrder[0]).toBeLessThan(
      deps.signCustomerSession.mock.invocationCallOrder[0],
    );
    expect(deps.signCustomerSession.mock.invocationCallOrder[0]).toBeLessThan(
      deps.challengeStore.completeLogin.mock.invocationCallOrder[0],
    );
    expect(deps.usersData.findOne).not.toHaveBeenCalled();
    expect(deps.issueBookingGrant).not.toHaveBeenCalled();
    expect(result).toEqual({
      purpose: "login",
      sessionToken: "candidate-session-token",
      sessionTtlSeconds: 3_600,
    });
  });

  it("leaves the login challenge active when session signing fails", async () => {
    const challenge = activeChallenge({ purpose: "login" });
    const signingError = new Error("session signing unavailable");
    const deps = createDeps(challenge, {
      signCustomerSession: vi.fn().mockRejectedValue(signingError),
    });

    await expect(
      completeOtpChallenge(
        {
          challengeToken: "challenge-token",
          provider: "firebase",
          idToken: "transient-id-token",
        },
        deps,
      ),
    ).rejects.toBe(signingError);
    expect(challenge.status).toBe("pending");
    expect(deps.challengeStore.completeLogin).not.toHaveBeenCalled();
    expect(deps.usersData.findOne).not.toHaveBeenCalled();
    expect(deps.issueBookingGrant).not.toHaveBeenCalled();
  });

  it("does not sign or CAS when login Firebase evidence is rejected", async () => {
    const challenge = activeChallenge({ purpose: "login" });
    const adminAuth = {
      verifyIdToken: vi.fn().mockRejectedValue(new Error("rejected")),
    };
    const deps = createDeps(challenge, {
      verifyFirebaseEvidence: (input) =>
        verifyFirebaseEvidenceContract(input, { adminAuth }),
    });

    await expectOtpError(
      completeOtpChallenge(
        {
          challengeToken: "challenge-token",
          provider: "firebase",
          idToken: "untrusted-id-token",
        },
        deps,
      ),
      "INVALID_FIREBASE_TOKEN",
      401,
    );
    expect(deps.signCustomerSession).not.toHaveBeenCalled();
    expect(deps.challengeStore.completeLogin).not.toHaveBeenCalled();
    expect(deps.usersData.findOne).not.toHaveBeenCalled();
    expect(deps.issueBookingGrant).not.toHaveBeenCalled();
  });

  it("maps a login CAS loss to the existing already-completed error", async () => {
    const deps = createDeps(activeChallenge({ purpose: "login" }));
    deps.challengeStore.completeLogin.mockResolvedValue(null);

    await expectOtpError(
      completeOtpChallenge(
        {
          challengeToken: "challenge-token",
          provider: "firebase",
          idToken: "transient-id-token",
        },
        deps,
      ),
      "OTP_CHALLENGE_ALREADY_COMPLETED",
      409,
    );
    expect(deps.signCustomerSession).toHaveBeenCalledTimes(1);
    expect(deps.usersData.findOne).not.toHaveBeenCalled();
    expect(deps.issueBookingGrant).not.toHaveBeenCalled();
  });

  it("maps a purpose-changed login CAS loss to the existing safe error", async () => {
    const challenge = activeChallenge({ purpose: "login" });
    const { challengeStore, collection } =
      await createProductionChallengeStore(challenge);
    const deps = createDeps(challenge, {
      challengeStore,
      verifyFirebaseEvidence: vi.fn().mockImplementation(async () => {
        collection.current = { ...collection.current, purpose: "booking" };
        return STORED_PHONE;
      }),
    });

    await expectOtpError(
      completeOtpChallenge(
        {
          challengeToken: "challenge-token",
          provider: "firebase",
          idToken: "transient-id-token",
        },
        deps,
      ),
      "OTP_CHALLENGE_ALREADY_COMPLETED",
      409,
    );
    expect(collection.current).toMatchObject({
      purpose: "booking",
      status: "pending",
    });
    const completionCall = collection.calls.find(
      ({ operation }) => operation === "findOneAndUpdate",
    );
    expect(completionCall.filter).toEqual({
      _id: challenge._id,
      challengeTokenHash: CHALLENGE_TOKEN_HASH,
      purpose: "login",
      provider: "firebase",
      status: "pending",
      expiresAt: { $gt: NOW },
    });
    expect(deps.signCustomerSession).toHaveBeenCalledTimes(1);
    expect(deps.usersData.findOne).not.toHaveBeenCalled();
    expect(deps.issueBookingGrant).not.toHaveBeenCalled();
  });

  it("rejects an unsafe login expiration before the CAS", async () => {
    const issuedAt = Math.floor(NOW.getTime() / 1_000);
    const unsafeTtlSeconds = Number.MAX_SAFE_INTEGER - issuedAt + 1;
    const challenge = activeChallenge({ purpose: "login" });
    const deps = createDeps(challenge, {
      env: {
        NODE_ENV: "test",
        OTP_DEV_CODE: "654321",
        CUSTOMER_SESSION_SECRET: "c".repeat(32),
        CUSTOMER_SESSION_TTL_SECONDS: String(unsafeTtlSeconds),
      },
    });
    delete deps.signCustomerSession;

    const error = await captureExpectedError(() =>
      completeOtpChallenge(
        {
          challengeToken: "challenge-token",
          provider: "firebase",
          idToken: "transient-id-token",
        },
        deps,
      ),
    );

    expect(error).toMatchObject({
      code: "CUSTOMER_SESSION_NOT_CONFIGURED",
      status: 503,
      message: "Customer session is unavailable.",
    });
    expect(deps.challengeStore.completeLogin).not.toHaveBeenCalled();
    expect(deps.usersData.findOne).not.toHaveBeenCalled();
    expect(deps.issueBookingGrant).not.toHaveBeenCalled();
  });

  it("allows exactly one concurrent or repeated login completion winner", async () => {
    const challenge = activeChallenge({ purpose: "login" });
    const { challengeStore, collection } =
      await createProductionChallengeStore(challenge);
    const deps = createDeps(challenge, { challengeStore });
    const payload = {
      challengeToken: "challenge-token",
      provider: "firebase",
      idToken: "transient-id-token",
    };

    const outcomes = await Promise.allSettled([
      completeOtpChallenge(payload, deps),
      completeOtpChallenge(payload, deps),
    ]);

    expect(outcomes.filter(({ status: kind }) => kind === "fulfilled")).toHaveLength(1);
    const loser = outcomes.find(({ status: kind }) => kind === "rejected");
    expect(loser.reason).toMatchObject({
      code: "OTP_CHALLENGE_ALREADY_COMPLETED",
      status: 409,
    });
    expect(deps.signCustomerSession).toHaveBeenCalledTimes(2);
    const completionCalls = collection.calls.filter(
      ({ operation }) => operation === "findOneAndUpdate",
    );
    expect(completionCalls).toHaveLength(2);
    expect(completionCalls.map(({ filter }) => filter)).toEqual([
      {
        _id: challenge._id,
        challengeTokenHash: CHALLENGE_TOKEN_HASH,
        purpose: "login",
        provider: "firebase",
        status: "pending",
        expiresAt: { $gt: NOW },
      },
      {
        _id: challenge._id,
        challengeTokenHash: CHALLENGE_TOKEN_HASH,
        purpose: "login",
        provider: "firebase",
        status: "pending",
        expiresAt: { $gt: NOW },
      },
    ]);
    expect(deps.usersData.findOne).not.toHaveBeenCalled();
    expect(deps.issueBookingGrant).not.toHaveBeenCalled();

    await expectOtpError(
      completeOtpChallenge(payload, deps),
      "OTP_CHALLENGE_ALREADY_COMPLETED",
      409,
    );
    expect(deps.signCustomerSession).toHaveBeenCalledTimes(2);
  });

  it("keeps booking completion isolated from customer sessions", async () => {
    const deps = createDeps();

    await completeOtpChallenge(
      {
        challengeToken: "challenge-token",
        provider: "firebase",
        idToken: "transient-id-token",
      },
      deps,
    );

    expect(deps.signCustomerSession).not.toHaveBeenCalled();
    expect(deps.challengeStore.completeLogin).not.toHaveBeenCalled();
    expect(deps.issueBookingGrant).toHaveBeenCalledTimes(1);
  });

  it.each([
    [null],
    [{}],
    [{ firstName: "  Ada  ", lastName: "   " }],
    [{ firstName: 42, lastName: "Lovelace" }],
  ])("returns only incomplete-name state for missing or incomplete profiles", async (storedProfile) => {
    const deps = createDeps();
    deps.usersData.findOne.mockResolvedValue(storedProfile);

    const result = await completeOtpChallenge(
      {
        challengeToken: "challenge-token",
        provider: "firebase",
        idToken: "transient-id-token",
      },
      deps,
    );

    expect(result.profile).toEqual({ hasCompleteName: false });
    expect(result.profile).not.toHaveProperty("exists");
    expect(Object.keys(result.profile)).toEqual(["hasCompleteName"]);
  });

  it("keeps the challenge retryable when profile lookup fails", async () => {
    const lookupError = new Error("database unavailable");
    const deps = createDeps();
    deps.usersData.findOne.mockRejectedValue(lookupError);

    await expect(
      completeOtpChallenge(
        {
          challengeToken: "challenge-token",
          provider: "firebase",
          idToken: "transient-id-token",
        },
        deps,
      ),
    ).rejects.toBe(lookupError);
    expect(deps.verifyFirebaseEvidence).toHaveBeenCalledTimes(1);
    expect(deps.issueBookingGrant).not.toHaveBeenCalled();
  });
});
