import { beforeEach, describe, expect, it, vi } from "vitest";
import { ObjectId } from "mongodb";
import {
  consumeBookingGrant,
  issueBookingGrant,
  isTransactionUnsupportedError,
  releaseBookingGrant,
} from "@/lib/otp/bookingGrant";
import { createOtpChallengeStore } from "@/lib/otp/challengeStore";
import { hashBearerToken } from "@/lib/otp/crypto";
import { OTP_GRANT_TTL_MS } from "@/lib/otp/constants";
import {
  createTestClock,
  MemoryMongoClient,
  MemoryMongoCollection,
} from "../helpers/memoryOtpStores";

const CHALLENGE_HASH = "challenge-hash-a";
const CHALLENGE_ID = "68ab2ec00000000000000001";
const CANONICAL_UNSUPPORTED_MESSAGE =
  "Transaction numbers are only allowed on a replica set member or mongos";

function transactionUnsupportedError(message = CANONICAL_UNSUPPORTED_MESSAGE) {
  return Object.assign(new Error(message), {
    code: 20,
    codeName: "IllegalOperation",
  });
}

function makeChallenge(overrides = {}) {
  return {
    _id: new ObjectId(CHALLENGE_ID),
    phone: "phone-a",
    purpose: "booking",
    challengeTokenHash: CHALLENGE_HASH,
    provider: "firebase",
    status: "pending",
    createdAt: new Date("2026-08-23T11:59:00.000Z"),
    updatedAt: new Date("2026-08-23T11:59:00.000Z"),
    expiresAt: new Date("2026-08-23T12:10:00.000Z"),
    ...overrides,
  };
}

function errorCode(error) {
  return error?.code;
}

describe("MemoryMongoClient transaction harness", () => {
  function makeHarness() {
    const collection = new MemoryMongoCollection([
      { _id: new ObjectId(CHALLENGE_ID), status: "pending", attempt: 0 },
    ]);
    const client = new MemoryMongoClient([collection]);
    return { client, collection };
  }

  it("isolates transactional writes until an explicit commit", async () => {
    const { client, collection } = makeHarness();
    const session = client.startSession();

    await session.withTransaction(async () => {
      await collection.updateOne(
        { _id: new ObjectId(CHALLENGE_ID) },
        { $set: { status: "completed" } },
        { session },
      );

      expect(collection.current.status).toBe("pending");
      await expect(
        collection.findOne(
          { _id: new ObjectId(CHALLENGE_ID) },
          { session },
        ),
      ).resolves.toMatchObject({ status: "completed" });
    });

    expect(collection.current.status).toBe("completed");
    expect(client.commitAttempts).toBe(1);
  });

  it("aborts only the session-local transaction snapshot", async () => {
    const { client, collection } = makeHarness();
    const session = client.startSession();

    await expect(
      session.withTransaction(async () => {
        await collection.updateOne(
          { _id: new ObjectId(CHALLENGE_ID) },
          { $set: { status: "completed" } },
          { session },
        );
        throw new Error("abort transaction");
      }),
    ).rejects.toThrow("abort transaction");

    expect(collection.current.status).toBe("pending");
    expect(client.commitAttempts).toBe(0);
  });

  it("fails a transaction operation that omits its session", async () => {
    const { client, collection } = makeHarness();
    const session = client.startSession();

    await expect(
      session.withTransaction(() =>
        collection.updateOne(
          { _id: new ObjectId(CHALLENGE_ID) },
          { $set: { status: "completed" } },
        ),
      ),
    ).rejects.toThrow("active transaction session");
    expect(collection.current.status).toBe("pending");
  });

  it("retries the callback from a clean snapshot", async () => {
    const { client, collection } = makeHarness();
    const session = client.startSession();
    client.callbackRetries = 1;

    await session.withTransaction(async () => {
      await collection.updateOne(
        { _id: new ObjectId(CHALLENGE_ID) },
        { $inc: { attempt: 1 } },
        { session },
      );
    });

    expect(client.callbackAttempts).toBe(2);
    expect(collection.current.attempt).toBe(1);
  });

  it("keeps committed state unchanged when commit fails", async () => {
    const { client, collection } = makeHarness();
    const session = client.startSession();
    client.failCommitWith = new Error("commit failed");

    await expect(
      session.withTransaction(() =>
        collection.updateOne(
          { _id: new ObjectId(CHALLENGE_ID) },
          { $set: { status: "completed" } },
          { session },
        ),
      ),
    ).rejects.toThrow("commit failed");
    expect(collection.current.status).toBe("pending");
  });

  it("can report an ambiguous commit after making it durable", async () => {
    const { client, collection } = makeHarness();
    const session = client.startSession();
    client.ambiguousCommitWith = new Error("ambiguous commit");

    await expect(
      session.withTransaction(() =>
        collection.updateOne(
          { _id: new ObjectId(CHALLENGE_ID) },
          { $set: { status: "completed" } },
          { session },
        ),
      ),
    ).rejects.toThrow("ambiguous commit");
    expect(collection.current.status).toBe("completed");
  });
});

describe("booking OTP grants", () => {
  let challenge;
  let challenges;
  let grants;
  let challengeStore;
  let client;
  let clock;
  let tokenNumber;
  let completionNumber;
  let deps;

  beforeEach(() => {
    challenge = makeChallenge();
    clock = createTestClock();
    challenges = new MemoryMongoCollection([challenge]);
    challenges.serverClock = clock;
    grants = new MemoryMongoCollection();
    challengeStore = createOtpChallengeStore({ collection: challenges });
    client = new MemoryMongoClient([challenges, grants]);
    tokenNumber = 0;
    completionNumber = 0;
    deps = {
      challengeStore,
      challenges,
      grants,
      client,
      clock,
      tokenFactory: vi.fn(() => `verification-plaintext-${++tokenNumber}`),
      hashToken: hashBearerToken,
      completionIdFactory: vi.fn(() => `completion-${++completionNumber}`),
    };
  });

  function fallbackOnly() {
    client.transactionsUnsupported = true;
  }

  function issue() {
    return issueBookingGrant({ challenge, challengeTokenHash: CHALLENGE_HASH }, deps);
  }

  function grantDeps() {
    return { challenges, grants, clock, hashToken: hashBearerToken };
  }

  function grantDocument({
    completionId,
    token = `plaintext-${completionId}`,
    createdAt = clock.now(),
    challengeId = challenge._id,
  }) {
    return {
      _id: `grant-${completionId}`,
      challengeId,
      completionId,
      phone: challenge.phone,
      tokenHash: hashBearerToken(token),
      status: "prepared",
      used: false,
      usedAt: null,
      appointmentId: null,
      createdAt,
      expiresAt: new Date(createdAt.getTime() + OTP_GRANT_TTL_MS),
    };
  }

  async function reserveLease({
    completionId,
    token = `plaintext-${completionId}`,
    startedAt = clock.now(),
  }) {
    return challengeStore.reserveCompletionLease({
      challengeId: challenge._id,
      challengeTokenHash: CHALLENGE_HASH,
      provider: challenge.provider,
      eligibleStatus: challenge.status,
      completionId,
      bookingGrantTokenHash: hashBearerToken(token),
      now: startedAt,
      leaseExpiresAt: new Date(startedAt.getTime() + 30_000),
    });
  }

  function pauseFirstSuccessfulReservation() {
    let markPaused;
    let resume;
    const paused = new Promise((resolve) => {
      markPaused = resolve;
    });
    const resumed = new Promise((resolve) => {
      resume = resolve;
    });
    const realStore = deps.challengeStore;
    let shouldPause = true;

    deps.challengeStore = {
      ...realStore,
      async reserveCompletionLease(...args) {
        const reserved = await realStore.reserveCompletionLease(...args);
        if (reserved && shouldPause) {
          shouldPause = false;
          markPaused();
          await resumed;
        }
        return reserved;
      },
    };

    return { paused, resume };
  }

  it("commits challenge completion and exactly one matching grant together", async () => {
    const result = await issue();

    expect(result.verificationToken).toBeDefined();
    expect(challenges.current).toMatchObject({ status: "completed" });
    expect(grants.documents).toHaveLength(1);
    expect(grants.documents[0]).toMatchObject({
      challengeId: challenge._id,
      completionId: challenges.current.completionId,
      phone: challenge.phone,
      status: "prepared",
      used: false,
      usedAt: null,
      appointmentId: null,
    });
    expect(JSON.stringify(grants.documents[0])).not.toContain(
      result.verificationToken,
    );
  });

  it("rolls back both documents when grant insertion fails in a transaction", async () => {
    grants.failNextPrepare = true;

    await expect(issue()).rejects.toBeDefined();
    expect(challenges.current.status).toBe("pending");
    expect(grants.documents).toHaveLength(0);
  });

  it("allows one winner under concurrent completion", async () => {
    const results = await Promise.allSettled([issue(), issue()]);

    expect(results.filter((item) => item.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((item) => item.status === "rejected")).toHaveLength(1);
    expect(errorCode(results.find((item) => item.status === "rejected").reason)).toBe(
      "OTP_CHALLENGE_ALREADY_COMPLETED",
    );
    expect(grants.documents).toHaveLength(1);
  });

  it("creates the exact unique and TTL indexes while tolerating unlinked legacy grants", async () => {
    grants.documents.push(
      { _id: "legacy-a", tokenHash: "legacy-hash-a" },
      { _id: "legacy-b", tokenHash: "legacy-hash-b" },
    );

    await issue();

    expect(grants.indexes).toEqual(
      expect.arrayContaining([
        {
          keys: { tokenHash: 1 },
          options: { unique: true, name: "otp_grant_unique_tokenHash" },
        },
        {
          keys: { challengeId: 1 },
          options: {
            unique: true,
            name: "otp_grant_unique_challenge",
            partialFilterExpression: { challengeId: { $type: "objectId" } },
          },
        },
        {
          keys: { expiresAt: 1 },
          options: { expireAfterSeconds: 0, name: "otp_grant_expiresAt_ttl" },
        },
      ]),
    );
  });

  it("recognizes only canonical typed standalone transaction errors", () => {
    const canonical = transactionUnsupportedError();
    expect(isTransactionUnsupportedError(canonical)).toBe(true);
    expect(
      isTransactionUnsupportedError(new Error("outer", { cause: canonical })),
    ).toBe(true);

    expect(isTransactionUnsupportedError({ codeName: "IllegalOperation" })).toBe(
      false,
    );
    expect(
      isTransactionUnsupportedError(new Error(CANONICAL_UNSUPPORTED_MESSAGE)),
    ).toBe(false);
    expect(
      isTransactionUnsupportedError(
        transactionUnsupportedError("Transaction not supported"),
      ),
    ).toBe(false);
    expect(
      isTransactionUnsupportedError(
        Object.assign(new Error(CANONICAL_UNSUPPORTED_MESSAGE), {
          code: 20,
          codeName: "OtherOperation",
        }),
      ),
    ).toBe(false);
    expect(
      isTransactionUnsupportedError(
        new Error("outer", {
          cause: new Error("middle", { cause: canonical }),
        }),
      ),
    ).toBe(false);
  });

  it("uses lease fallback for a canonical unsupported error before any write", async () => {
    fallbackOnly();

    await expect(issue()).resolves.toHaveProperty("verificationToken");
    expect(client.callbackAttempts).toBe(0);
    expect(challenges.current.status).toBe("completed");
    expect(grants.documents).toHaveLength(1);
  });

  it("uses lease fallback when the first transactional write is unsupported", async () => {
    challenges.failNextWriteWith = transactionUnsupportedError();

    await expect(issue()).resolves.toHaveProperty("verificationToken");
    expect(client.callbackAttempts).toBe(1);
    expect(challenges.current.status).toBe("completed");
    expect(grants.documents).toHaveLength(1);
  });

  it.each([
    ["grant insertion", "failNextPrepareWith"],
    ["post-insert response", "throwAfterPrepareWith"],
  ])(
    "does not enter lease fallback after transactional %s failure",
    async (_phase, failureProperty) => {
      const error = transactionUnsupportedError();
      grants[failureProperty] = error;

      await expect(issue()).rejects.toBe(error);
      expect(client.callbackAttempts).toBe(1);
      expect(challenges.current.status).toBe("pending");
      expect(grants.documents).toHaveLength(0);
    },
  );

  it("does not enter lease fallback after a callback has performed writes", async () => {
    const error = transactionUnsupportedError();
    client.callbackRetries = 1;
    client.onCallbackRetry = () => {
      client.beforeCallbackAttempt = (attempt) => {
        if (attempt === 2) throw error;
      };
    };

    await expect(issue()).rejects.toBe(error);
    expect(client.callbackAttempts).toBe(2);
    expect(challenges.current.status).toBe("pending");
    expect(grants.documents).toHaveLength(0);
  });

  it("fails closed when a transaction does not commit", async () => {
    const error = transactionUnsupportedError();
    client.failCommitWith = error;

    await expect(issue()).rejects.toBe(error);
    expect(challenges.current.status).toBe("pending");
    expect(grants.documents).toHaveLength(0);
  });

  it("returns the same plaintext token after exact ambiguous-commit readback", async () => {
    const error = transactionUnsupportedError();
    client.ambiguousCommitWith = error;

    await expect(issue()).resolves.toEqual({
      verificationToken: "verification-plaintext-1",
    });
    expect(challenges.current).toMatchObject({
      status: "completed",
      completionId: "completion-1",
    });
    expect(grants.documents).toEqual([
      expect.objectContaining({
        challengeId: challenge._id,
        completionId: "completion-1",
        tokenHash: hashBearerToken("verification-plaintext-1"),
        status: "prepared",
        used: false,
      }),
    ]);
    expect(
      grants.calls.filter((call) => call.operation === "findOne"),
    ).toEqual([
      expect.objectContaining({
        filter: {
          challengeId: challenge._id,
          completionId: "completion-1",
          tokenHash: hashBearerToken("verification-plaintext-1"),
        },
      }),
    ]);
  });

  it("preserves confirmed success when session cleanup fails after commit", async () => {
    const error = transactionUnsupportedError();
    client.endSessionError = error;

    await expect(issue()).resolves.toEqual({
      verificationToken: "verification-plaintext-1",
    });
    expect(challenges.current.status).toBe("completed");
    expect(grants.documents).toHaveLength(1);
  });

  it("fails closed when ambiguous committed state has a mismatched grant hash", async () => {
    const error = transactionUnsupportedError();
    client.ambiguousCommitWith = error;
    client.afterAmbiguousCommit = () => {
      grants.documents[0].tokenHash = hashBearerToken("different-plaintext");
    };

    await expect(issue()).rejects.toBe(error);
    expect(challenges.current).toMatchObject({
      status: "completed",
      completionId: "completion-1",
    });
    expect(grants.documents[0]).toMatchObject({
      completionId: "completion-1",
      tokenHash: hashBearerToken("different-plaintext"),
    });
    expect(
      grants.calls.filter((call) => call.operation === "findOne"),
    ).toHaveLength(1);
  });

  it.each([
    ["malformed", () => "not-a-date"],
    [
      "mismatched",
      (expiresAt) => new Date(expiresAt.getTime() + 1),
    ],
  ])(
    "fails closed when ambiguous committed state has a %s grant expiry",
    async (_name, mutateExpiry) => {
      const error = transactionUnsupportedError();
      client.ambiguousCommitWith = error;
      client.afterAmbiguousCommit = () => {
        grants.documents[0].expiresAt = mutateExpiry(
          grants.documents[0].expiresAt,
        );
      };

      await expect(issue()).rejects.toBe(error);
      expect(deps.tokenFactory).toHaveBeenCalledTimes(1);
      expect(grants.documents[0]).toMatchObject({
        challengeId: challenge._id,
        completionId: "completion-1",
        tokenHash: hashBearerToken("verification-plaintext-1"),
        used: false,
      });
    },
  );

  it("CAS-reissues only its own exact grant when fresh read-back time finds it expired", async () => {
    const error = transactionUnsupportedError();
    const originalExpiresAt = new Date(clock.now().getTime() + OTP_GRANT_TTL_MS);
    const advanceAfterRead = vi.fn(() => clock.advance(OTP_GRANT_TTL_MS));
    client.ambiguousCommitWith = error;
    client.afterAmbiguousCommit = () => {
      client.ambiguousCommitWith = null;
      client.afterAmbiguousCommit = null;
      grants.afterNextFindOne = advanceAfterRead;
    };

    const result = await issue();

    expect(advanceAfterRead).toHaveBeenCalledTimes(1);
    expect(clock.now()).toEqual(new Date("2026-08-23T12:10:00.000Z"));
    expect(result).toEqual({
      verificationToken: "verification-plaintext-2",
    });

    expect(challenges.current).toMatchObject({
      status: "completed",
      completionId: "completion-1",
    });
    expect(grants.documents).toEqual([
      expect.objectContaining({
        challengeId: challenge._id,
        completionId: "completion-1",
        tokenHash: hashBearerToken("verification-plaintext-2"),
        status: "prepared",
        used: false,
        usedAt: null,
        appointmentId: null,
        createdAt: new Date("2026-08-23T12:10:00.000Z"),
        expiresAt: new Date("2026-08-23T12:20:00.000Z"),
      }),
    ]);
    expect(
      grants.calls.find(
        (call) =>
          call.operation === "findOneAndUpdate" &&
          call.update?.$set?.tokenHash ===
            hashBearerToken("verification-plaintext-2"),
      )?.filter,
    ).toMatchObject({
      challengeId: challenge._id,
      completionId: "completion-1",
      tokenHash: hashBearerToken("verification-plaintext-1"),
      status: "prepared",
      used: false,
      usedAt: null,
      appointmentId: null,
      expiresAt: originalExpiresAt,
    });
  });

  it("allows one blocked parallel winner to reissue an expired ambiguous grant", async () => {
    const error = transactionUnsupportedError();
    let releaseReissue;
    let markReissueStarted;
    const reissueGate = new Promise((resolve) => {
      releaseReissue = resolve;
    });
    const reissueStarted = new Promise((resolve) => {
      markReissueStarted = resolve;
    });
    client.ambiguousCommitWith = error;
    client.afterAmbiguousCommit = () => {
      client.ambiguousCommitWith = null;
      client.afterAmbiguousCommit = null;
      clock.advance(OTP_GRANT_TTL_MS);
      client.beforeCallbackAttempt = async (attempt) => {
        if (attempt === 2) {
          markReissueStarted();
          await reissueGate;
        }
      };
    };

    const first = issue();
    await reissueStarted;
    const second = issue();
    releaseReissue();
    const results = await Promise.allSettled([first, second]);

    expect(results.filter((result) => result.status === "fulfilled")).toEqual([
      {
        status: "fulfilled",
        value: { verificationToken: "verification-plaintext-2" },
      },
    ]);
    expect(results.filter((result) => result.status === "rejected")).toEqual([
      expect.objectContaining({
        status: "rejected",
        reason: expect.objectContaining({
          code: "OTP_CHALLENGE_ALREADY_COMPLETED",
        }),
      }),
    ]);
    expect(grants.documents).toEqual([
      expect.objectContaining({
        completionId: "completion-1",
        tokenHash: hashBearerToken("verification-plaintext-2"),
        used: false,
      }),
    ]);
  });

  it("uses fresh time after setup work before attempting completion", async () => {
    grants.afterNextCreateIndex = () => clock.advance(600_001);

    await expect(issue()).rejects.toMatchObject({
      code: "OTP_VERIFICATION_INVALID",
    });
    expect(challenges.current.status).toBe("pending");
    expect(grants.documents).toHaveLength(0);
  });

  it("uses fresh time and TTL on every transaction callback attempt", async () => {
    client.callbackRetries = 1;
    client.onCallbackRetry = () => clock.advance(5_000);

    await issue();

    expect(client.callbackAttempts).toBe(2);
    expect(grants.documents[0].createdAt).toEqual(
      new Date("2026-08-23T12:00:05.000Z"),
    );
    expect(grants.documents[0].expiresAt).toEqual(
      new Date("2026-08-23T12:10:05.000Z"),
    );
    expect(challenges.current.completedAt).toEqual(
      new Date("2026-08-23T12:00:05.000Z"),
    );
  });

  it.each([
    ["firebase", "pending"],
    ["development", "pending"],
    ["twilio", "twilio_sent"],
  ])(
    "restores %s challenges after fallback grant prepare failure",
    async (provider, status) => {
      challenge = makeChallenge({ provider, status });
      challenges.current = challenge;
      fallbackOnly();
      grants.failNextPrepare = true;

      await expect(issue()).rejects.toThrow("Simulated grant prepare failure");

      expect(challenges.documents[0].status).toBe(status);
      expect(challenges.documents[0]).not.toHaveProperty("completionId");
      expect(grants.documents).toHaveLength(0);
    },
  );

  it("deletes its prepared grant and restores status when final challenge CAS fails", async () => {
    fallbackOnly();
    challenges.failNextFinalize = true;

    await expect(issue()).rejects.toMatchObject({
      code: "OTP_VERIFICATION_INVALID",
    });

    expect(challenges.documents[0].status).toBe("pending");
    expect(challenges.documents[0]).not.toHaveProperty("completionId");
    expect(grants.documents).toHaveLength(0);
    expect(grants.calls).toContainEqual(
      expect.objectContaining({
        operation: "deleteOne",
        filter: expect.objectContaining({
          challengeId: challenge._id,
          completionId: "completion-1",
        }),
      }),
    );
  });

  it("recovers an expired post-prepare lease before issuing one new grant", async () => {
    fallbackOnly();
    challenge = makeChallenge({
      _id: new ObjectId("68ab2ec00000000000000001"),
    });
    challenges.current = challenge;
    const startedAt = clock.now();
    const oldCompletionId = "abandoned-completion";
    const oldTokenHash = hashBearerToken("abandoned-plaintext");

    await challengeStore.reserveCompletionLease({
      challengeId: challenge._id,
      challengeTokenHash: CHALLENGE_HASH,
      provider: challenge.provider,
      eligibleStatus: challenge.status,
      completionId: oldCompletionId,
      bookingGrantTokenHash: oldTokenHash,
      now: startedAt,
      leaseExpiresAt: new Date(startedAt.getTime() + 30_000),
    });
    await grants.updateOne(
      { challengeId: challenge._id },
      {
        $setOnInsert: {
          challengeId: challenge._id,
          completionId: oldCompletionId,
          phone: challenge.phone,
          tokenHash: oldTokenHash,
          status: "prepared",
          used: false,
          usedAt: null,
          appointmentId: null,
          createdAt: startedAt,
          expiresAt: new Date(startedAt.getTime() + OTP_GRANT_TTL_MS),
        },
      },
      { upsert: true },
    );

    await expect(
      consumeBookingGrant(
        {
          phone: challenge.phone,
          verificationToken: "abandoned-plaintext",
          appointmentId: "appointment-a",
        },
        grantDeps(),
      ),
    ).rejects.toMatchObject({ code: "OTP_VERIFICATION_INVALID" });

    clock.advance(31_000);
    const result = await issue();

    expect(result.verificationToken).toBeDefined();
    expect(challenges.documents[0]).toMatchObject({
      status: "completed",
      completionId: "completion-1",
    });
    expect(grants.documents).toHaveLength(1);
    expect(grants.documents[0]).toMatchObject({
      challengeId: challenge._id,
      completionId: "completion-1",
    });
    expect(grants.documents[0].tokenHash).not.toBe(oldTokenHash);
  });

  it("fences an expired lease before a stale finalizer can run during cleanup", async () => {
    fallbackOnly();
    const capturedBeforeExpiry = clock.now();
    const oldCompletionId = "stale-finalizer-completion";
    const oldToken = "stale-finalizer-plaintext";
    const oldTokenHash = hashBearerToken(oldToken);

    await reserveLease({
      completionId: oldCompletionId,
      token: oldToken,
      startedAt: capturedBeforeExpiry,
    });
    grants.documents.push(
      grantDocument({
        completionId: oldCompletionId,
        token: oldToken,
        createdAt: capturedBeforeExpiry,
      }),
    );
    clock.advance(31_000);

    let staleFinalizeResult;
    grants.beforeNextDelete = async () => {
      staleFinalizeResult = await challengeStore.finalizeCompletionLease({
        challengeId: challenge._id,
        challengeTokenHash: CHALLENGE_HASH,
        completionId: oldCompletionId,
        bookingGrantTokenHash: oldTokenHash,
        now: capturedBeforeExpiry,
      });
    };

    await expect(issue()).resolves.toHaveProperty("verificationToken");
    expect(staleFinalizeResult).toBeNull();
    expect(challenges.current).toMatchObject({
      status: "completed",
      completionId: "completion-1",
    });
    expect(grants.documents).toHaveLength(1);
    expect(grants.documents[0].completionId).toBe("completion-1");
  });

  it("takes fresh fallback reservation time after expired-lease cleanup", async () => {
    fallbackOnly();
    const oldCompletionId = "cleanup-delay-completion";
    const oldToken = "cleanup-delay-plaintext";
    const startedAt = clock.now();

    await reserveLease({ completionId: oldCompletionId, token: oldToken, startedAt });
    grants.documents.push(
      grantDocument({ completionId: oldCompletionId, token: oldToken, createdAt: startedAt }),
    );
    clock.advance(31_000);
    grants.afterNextDelete = () => clock.advance(5_000);

    await issue();

    expect(grants.documents[0].createdAt).toEqual(
      new Date("2026-08-23T12:00:36.000Z"),
    );
    expect(grants.documents[0].expiresAt).toEqual(
      new Date("2026-08-23T12:10:36.000Z"),
    );
  });

  it("leaves a prepared grant and lease reconcilable when finalize fails before commit", async () => {
    fallbackOnly();
    challenges.finalizeErrorMode = "before";

    await expect(issue()).rejects.toMatchObject({
      code: "OTP_COMPLETION_IN_PROGRESS",
    });
    expect(challenges.current).toMatchObject({
      status: "completing",
      completionId: "completion-1",
    });
    expect(grants.documents).toHaveLength(1);
    expect(grants.documents[0].completionId).toBe("completion-1");

    clock.advance(31_000);
    await expect(issue()).resolves.toHaveProperty("verificationToken");
    expect(challenges.current).toMatchObject({
      status: "completed",
      completionId: "completion-2",
    });
    expect(grants.documents).toHaveLength(1);
  });

  it("never deletes a grant whose ambiguous finalize becomes visible later", async () => {
    fallbackOnly();
    challenges.finalizeErrorMode = "deferred";

    await expect(issue()).rejects.toMatchObject({
      code: "OTP_COMPLETION_IN_PROGRESS",
    });
    expect(challenges.current).toMatchObject({
      status: "completing",
      completionId: "completion-1",
    });
    expect(grants.documents).toHaveLength(1);

    await challenges.flushDeferredWrites();

    expect(challenges.current).toMatchObject({
      status: "completed",
      completionId: "completion-1",
    });
    expect(grants.documents).toHaveLength(1);
    expect(grants.documents[0].completionId).toBe("completion-1");
  });

  it("confirms durable success when finalization commits before its response fails", async () => {
    fallbackOnly();
    challenges.throwAfterFinalize = true;

    const result = await issue();

    expect(result.verificationToken).toBeDefined();
    expect(challenges.current).toMatchObject({
      status: "completed",
      completionId: "completion-1",
    });
    expect(grants.documents).toHaveLength(1);
    expect(grants.documents[0]).toMatchObject({
      challengeId: challenge._id,
      completionId: "completion-1",
      status: "prepared",
    });
  });

  it("keeps a failed cleanup grant unusable after fencing so retry can replace it", async () => {
    fallbackOnly();
    challenges.failNextFinalize = true;
    grants.failNextDelete = true;

    await expect(issue()).rejects.toBeDefined();
    expect(challenges.current.status).toBe("pending");
    expect(grants.documents).toHaveLength(1);

    clock.advance(31_000);
    const result = await issue();

    expect(result.verificationToken).toBeDefined();
    expect(challenges.current).toMatchObject({
      status: "completed",
      completionId: "completion-2",
    });
    expect(grants.documents).toHaveLength(1);
    expect(grants.documents[0].completionId).toBe("completion-2");
  });

  it("refuses to finalize after work outlives the 30-second lease", async () => {
    fallbackOnly();
    grants.afterNextFindOne = () => {
      grants.afterNextFindOne = () => clock.advance(31_000);
    };

    await expect(issue()).rejects.toMatchObject({
      code: "OTP_VERIFICATION_INVALID",
    });

    expect(challenges.current.status).toBe("pending");
    expect(challenges.current).not.toHaveProperty("completionId");
    expect(grants.documents).toHaveLength(0);
  });

  it("rejects a prepared grant while its linked challenge is completing", async () => {
    fallbackOnly();
    const now = clock.now();
    const token = "prepared-plaintext";
    challenges.documents[0] = makeChallenge({
      status: "completing",
      completionId: "completion-prepared",
      completionPreviousStatus: "pending",
      completionLeaseExpiresAt: new Date(now.getTime() + 30_000),
      bookingGrantTokenHash: hashBearerToken(token),
    });
    grants.documents.push({
      _id: "grant-prepared",
      challengeId: challenge._id,
      completionId: "completion-prepared",
      phone: challenge.phone,
      tokenHash: hashBearerToken(token),
      status: "prepared",
      used: false,
      usedAt: null,
      appointmentId: null,
      createdAt: now,
      expiresAt: new Date(now.getTime() + OTP_GRANT_TTL_MS),
    });

    await expect(
      consumeBookingGrant(
        {
          phone: challenge.phone,
          verificationToken: token,
          appointmentId: "appointment-a",
        },
        grantDeps(),
      ),
    ).rejects.toMatchObject({ code: "OTP_VERIFICATION_INVALID" });
    expect(grants.documents[0].used).toBe(false);
  });

  it("reports an active completion lease without exposing its prepared grant", async () => {
    fallbackOnly();
    const now = clock.now();
    challenges.documents[0] = makeChallenge({
      status: "completing",
      completionId: "completion-active",
      completionPreviousStatus: "pending",
      completionLeaseExpiresAt: new Date(now.getTime() + 30_000),
      bookingGrantTokenHash: "grant-hash-active",
    });

    await expect(issue()).rejects.toMatchObject({
      code: "OTP_COMPLETION_IN_PROGRESS",
    });
    expect(grants.documents).toHaveLength(0);
  });

  it("allows one fallback winner under concurrent completion", async () => {
    fallbackOnly();

    const results = await Promise.allSettled([issue(), issue()]);

    expect(results.filter((item) => item.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((item) => item.status === "rejected")).toHaveLength(1);
    expect(grants.documents).toHaveLength(1);
    expect(challenges.current.status).toBe("completed");
  });

  it("consumes a completed linked grant once with phone and session binding", async () => {
    const { verificationToken } = await issue();
    const session = { id: "session-a" };

    await expect(
      consumeBookingGrant(
        {
          phone: "phone-b",
          verificationToken,
          appointmentId: "appointment-a",
          session,
        },
        grantDeps(),
      ),
    ).rejects.toMatchObject({ code: "OTP_VERIFICATION_INVALID" });

    const consumed = await consumeBookingGrant(
      {
        phone: challenge.phone,
        verificationToken,
        appointmentId: "appointment-a",
        session,
      },
      grantDeps(),
    );
    expect(consumed).toMatchObject({
      used: true,
      appointmentId: "appointment-a",
    });
    expect(
      challenges.calls.some(
        (call) => call.operation === "findOne" && call.options.session === session,
      ),
    ).toBe(true);
    expect(
      grants.calls.some(
        (call) =>
          call.operation === "findOneAndUpdate" && call.options.session === session,
      ),
    ).toBe(true);

    await expect(
      consumeBookingGrant(
        {
          phone: challenge.phone,
          verificationToken,
          appointmentId: "appointment-b",
          session,
        },
        grantDeps(),
      ),
    ).rejects.toMatchObject({ code: "OTP_VERIFICATION_ALREADY_USED" });
  });

  it("allows one consumer winner under concurrency", async () => {
    const { verificationToken } = await issue();

    const results = await Promise.allSettled([
      consumeBookingGrant(
        {
          phone: challenge.phone,
          verificationToken,
          appointmentId: "appointment-a",
        },
        grantDeps(),
      ),
      consumeBookingGrant(
        {
          phone: challenge.phone,
          verificationToken,
          appointmentId: "appointment-b",
        },
        grantDeps(),
      ),
    ]);

    expect(results.filter((item) => item.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((item) => item.status === "rejected")).toHaveLength(1);
    expect(errorCode(results.find((item) => item.status === "rejected").reason)).toBe(
      "OTP_VERIFICATION_ALREADY_USED",
    );
  });

  it("requires a token and rejects expired or legacy unlinked grants", async () => {
    await expect(
      consumeBookingGrant(
        { phone: challenge.phone, appointmentId: "appointment-a" },
        grantDeps(),
      ),
    ).rejects.toMatchObject({ code: "OTP_VERIFICATION_REQUIRED" });

    const { verificationToken } = await issue();
    clock.advance(OTP_GRANT_TTL_MS + 1);
    await expect(
      consumeBookingGrant(
        {
          phone: challenge.phone,
          verificationToken,
          appointmentId: "appointment-a",
        },
        grantDeps(),
      ),
    ).rejects.toMatchObject({ code: "OTP_VERIFICATION_EXPIRED" });

    const legacyToken = "legacy-plaintext";
    grants.documents.push({
      _id: "legacy-grant",
      phone: challenge.phone,
      tokenHash: hashBearerToken(legacyToken),
      used: false,
      createdAt: clock.now(),
      expiresAt: new Date(clock.now().getTime() + OTP_GRANT_TTL_MS),
    });
    await expect(
      consumeBookingGrant(
        {
          phone: challenge.phone,
          verificationToken: legacyToken,
          appointmentId: "appointment-a",
        },
        grantDeps(),
      ),
    ).rejects.toMatchObject({ code: "OTP_VERIFICATION_INVALID" });
  });

  it("conditionally releases only its matching appointment in the same session", async () => {
    const { verificationToken } = await issue();
    const session = { id: "session-release" };
    await consumeBookingGrant(
      {
        phone: challenge.phone,
        verificationToken,
        appointmentId: "appointment-a",
        session,
      },
      grantDeps(),
    );

    await releaseBookingGrant(
      {
        phone: challenge.phone,
        verificationToken,
        appointmentId: "appointment-other",
        session,
      },
      grantDeps(),
    );
    expect(grants.documents[0].used).toBe(true);

    await releaseBookingGrant(
      {
        phone: challenge.phone,
        verificationToken,
        appointmentId: "appointment-a",
        session,
      },
      grantDeps(),
    );
    expect(grants.documents[0]).toMatchObject({
      used: false,
      usedAt: null,
      appointmentId: null,
    });
    expect(
      grants.calls.some(
        (call) => call.operation === "updateOne" && call.options.session === session,
      ),
    ).toBe(true);
  });

  it("reuses an idempotently prepared challenge grant without creating a second record", async () => {
    fallbackOnly();
    const token = "verification-plaintext-1";
    const now = clock.now();
    grants.documents.push({
      _id: "grant-existing",
      challengeId: challenge._id,
      completionId: "completion-1",
      phone: challenge.phone,
      tokenHash: hashBearerToken(token),
      status: "prepared",
      used: false,
      usedAt: null,
      appointmentId: null,
      createdAt: now,
      expiresAt: new Date(now.getTime() + OTP_GRANT_TTL_MS),
    });

    const result = await issue();

    expect(result.verificationToken).toBe(token);
    expect(grants.documents).toHaveLength(1);
    expect(challenges.documents[0]).toMatchObject({
      status: "completed",
      completionId: "completion-1",
    });
  });

  it("resumes an exact active lease without creating a duplicate grant", async () => {
    fallbackOnly();
    const token = "verification-plaintext-1";
    const now = clock.now();
    await reserveLease({ completionId: "completion-1", token, startedAt: now });
    grants.documents.push(
      grantDocument({ completionId: "completion-1", token, createdAt: now }),
    );

    const result = await issue();

    expect(result.verificationToken).toBe(token);
    expect(challenges.current).toMatchObject({
      status: "completed",
      completionId: "completion-1",
    });
    expect(grants.documents).toHaveLength(1);
  });

  it("transactionally replaces an unlinked grant left by a rotated challenge", async () => {
    grants.documents.push(
      grantDocument({ completionId: "old-rotation-completion" }),
    );

    await expect(issue()).resolves.toHaveProperty("verificationToken");

    expect(challenges.current).toMatchObject({
      status: "completed",
      completionId: "completion-1",
    });
    expect(grants.documents).toHaveLength(1);
    expect(grants.documents[0].completionId).toBe("completion-1");
  });

  it("rolls back rotated-grant removal when transactional replacement fails", async () => {
    grants.documents.push(
      grantDocument({ completionId: "old-rotation-completion" }),
    );
    grants.failNextPrepare = true;

    await expect(issue()).rejects.toThrow("Simulated grant prepare failure");

    expect(challenges.current.status).toBe("pending");
    expect(grants.documents).toHaveLength(1);
    expect(grants.documents[0].completionId).toBe("old-rotation-completion");
  });

  it("lease mode replaces an unlinked grant left by a rotated challenge", async () => {
    fallbackOnly();
    grants.documents.push(
      grantDocument({ completionId: "old-rotation-completion" }),
    );

    await expect(issue()).resolves.toHaveProperty("verificationToken");

    expect(challenges.current).toMatchObject({
      status: "completed",
      completionId: "completion-1",
    });
    expect(grants.documents).toHaveLength(1);
    expect(grants.documents[0].completionId).toBe("completion-1");
  });

  it.each([
    ["after lease fencing", "pending", "stale-completion"],
    ["after reservation", "completing", "mismatched-completion"],
    ["after stale grant cleanup", "completing", null],
    ["after exact grant preparation", "completing", "abandoned-completion"],
  ])(
    "recovers process death %s",
    async (_phase, status, grantCompletionId) => {
      fallbackOnly();
      const abandonedCompletionId = "abandoned-completion";
      const abandonedToken = "abandoned-process-plaintext";
      const startedAt = clock.now();

      if (status === "completing") {
        await reserveLease({
          completionId: abandonedCompletionId,
          token: abandonedToken,
          startedAt,
        });
        clock.advance(31_000);
      }
      if (grantCompletionId) {
        grants.documents.push(
          grantDocument({
            completionId: grantCompletionId,
            token:
              grantCompletionId === abandonedCompletionId
                ? abandonedToken
                : "mismatched-process-plaintext",
            createdAt: startedAt,
          }),
        );
      }

      await expect(issue()).resolves.toHaveProperty("verificationToken");
      expect(challenges.current).toMatchObject({
        status: "completed",
        completionId: "completion-1",
      });
      expect(grants.documents).toHaveLength(1);
      expect(grants.documents[0].completionId).toBe("completion-1");
    },
  );

  it("handles a conflicting completion duplicate key without deleting the winner", async () => {
    fallbackOnly();
    const conflictingGrant = grantDocument({
      completionId: "conflicting-completion",
      token: "conflicting-plaintext",
    });
    grants.documents.push(
      grantDocument({ completionId: "old-rotation-completion" }),
    );
    grants.afterNextDelete = () => {
      grants.documents.push(conflictingGrant);
    };

    await expect(issue()).rejects.toMatchObject({
      code: "OTP_COMPLETION_IN_PROGRESS",
    });
    expect(challenges.current.status).toBe("pending");
    expect(grants.documents).toHaveLength(1);
    expect(grants.documents[0].completionId).toBe("conflicting-completion");
  });

  it("prevents an expired predecessor from deleting a completed successor grant", async () => {
    fallbackOnly();
    grants.documents.push(
      grantDocument({
        completionId: "predecessor-stale-completion",
        token: "predecessor-stale-plaintext",
      }),
    );
    const reservation = pauseFirstSuccessfulReservation();
    const predecessor = issue();
    await reservation.paused;

    clock.advance(31_000);
    const successor = await issue();
    const successorCompletionId = "completion-2";
    const successorTokenHash = hashBearerToken(successor.verificationToken);
    expect(challenges.current).toMatchObject({
      status: "completed",
      completionId: successorCompletionId,
    });
    expect(grants.documents).toHaveLength(1);
    expect(grants.documents[0]).toMatchObject({
      completionId: successorCompletionId,
      tokenHash: successorTokenHash,
    });

    reservation.resume();
    const [predecessorOutcome] = await Promise.allSettled([predecessor]);

    expect(predecessorOutcome.status).toBe("rejected");
    expect([
      "OTP_COMPLETION_IN_PROGRESS",
      "OTP_VERIFICATION_INVALID",
    ]).toContain(predecessorOutcome.reason.code);
    expect(challenges.current).toMatchObject({
      status: "completed",
      completionId: successorCompletionId,
    });
    expect(grants.documents).toHaveLength(1);
    expect(grants.documents[0]).toMatchObject({
      challengeId: challenge._id,
      completionId: successorCompletionId,
      tokenHash: successorTokenHash,
      status: "prepared",
      used: false,
    });

    await expect(
      consumeBookingGrant(
        {
          phone: challenge.phone,
          verificationToken: successor.verificationToken,
          appointmentId: "appointment-successor",
        },
        grantDeps(),
      ),
    ).resolves.toMatchObject({
      completionId: successorCompletionId,
      used: true,
    });
  });

  it("leaves a conflicting grant that appears after observation intact", async () => {
    fallbackOnly();
    const reservation = pauseFirstSuccessfulReservation();
    const predecessor = issue();
    await reservation.paused;

    const appearedGrant = grantDocument({
      completionId: "appeared-completion",
      token: "appeared-plaintext",
    });
    grants.documents.push(appearedGrant);

    reservation.resume();
    const [predecessorOutcome] = await Promise.allSettled([predecessor]);

    expect(predecessorOutcome.status).toBe("rejected");
    expect([
      "OTP_COMPLETION_IN_PROGRESS",
      "OTP_VERIFICATION_INVALID",
    ]).toContain(predecessorOutcome.reason.code);
    expect(challenges.current.status).toBe("pending");
    expect(grants.documents).toHaveLength(1);
    expect(grants.documents[0]).toMatchObject({
      _id: appearedGrant._id,
      challengeId: appearedGrant.challengeId,
      completionId: appearedGrant.completionId,
      tokenHash: appearedGrant.tokenHash,
      status: "prepared",
      used: false,
    });
  });

  it("leaves a pre-observed grant intact when it changes after reservation", async () => {
    fallbackOnly();
    const preExistingGrant = grantDocument({
      completionId: "pre-observed-completion",
      token: "pre-observed-plaintext",
    });
    grants.documents.push(preExistingGrant);
    const reservation = pauseFirstSuccessfulReservation();
    const predecessor = issue();
    await reservation.paused;

    grants.documents[0] = {
      ...grants.documents[0],
      used: true,
      usedAt: clock.now(),
      appointmentId: "appointment-changed",
    };

    reservation.resume();
    const [predecessorOutcome] = await Promise.allSettled([predecessor]);

    expect(predecessorOutcome.status).toBe("rejected");
    expect([
      "OTP_COMPLETION_IN_PROGRESS",
      "OTP_VERIFICATION_INVALID",
    ]).toContain(predecessorOutcome.reason.code);
    expect(challenges.current.status).toBe("pending");
    expect(grants.documents).toHaveLength(1);
    expect(grants.documents[0]).toMatchObject({
      _id: preExistingGrant._id,
      challengeId: preExistingGrant.challengeId,
      completionId: preExistingGrant.completionId,
      tokenHash: preExistingGrant.tokenHash,
      status: "prepared",
      used: true,
      appointmentId: "appointment-changed",
    });
  });

  it("accepts an exact prepared grant that wins the fallback upsert race", async () => {
    fallbackOnly();
    const duplicateError = Object.assign(new Error("Duplicate key"), {
      code: 11000,
    });
    grants.failNextPrepareWith = duplicateError;
    grants.beforeNextPrepareFailure = () => {
      grants.documents.push(
        grantDocument({
          completionId: "completion-1",
          token: "verification-plaintext-1",
        }),
      );
    };

    const result = await issue();

    expect(result.verificationToken).toBe("verification-plaintext-1");
    expect(challenges.current).toMatchObject({
      status: "completed",
      completionId: "completion-1",
    });
    expect(grants.documents).toHaveLength(1);
  });

  it("initializes grant indexes once across repeated stable-collection use", async () => {
    const { verificationToken } = await issue();

    await consumeBookingGrant(
      {
        phone: challenge.phone,
        verificationToken,
        appointmentId: "appointment-index",
      },
      grantDeps(),
    );
    await releaseBookingGrant(
      {
        phone: challenge.phone,
        verificationToken,
        appointmentId: "appointment-index",
      },
      grantDeps(),
    );

    expect(grants.indexes).toHaveLength(3);
  });
});
