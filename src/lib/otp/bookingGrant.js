import { ObjectId } from "mongodb";
import { isTransactionUnsupportedError } from "@/lib/mongoTransactions";
import {
  OTP_COMPLETION_LEASE_MS,
  OTP_GRANT_TTL_MS,
} from "@/lib/otp/constants";
import { createBearerToken, hashBearerToken } from "@/lib/otp/crypto";
import { getOtpChallengeStore } from "@/lib/otp/challengeStore";

const GRANT_COLLECTION_NAME = "otpVerificationGrants";
const CHALLENGE_COLLECTION_NAME = "otpChallenges";
const COMPLETION_ERROR_CODES = new Set([
  "OTP_COMPLETION_IN_PROGRESS",
  "OTP_CHALLENGE_ALREADY_COMPLETED",
]);
const ERROR_MESSAGES = {
  OTP_COMPLETION_IN_PROGRESS: "OTP completion is in progress.",
  OTP_CHALLENGE_ALREADY_COMPLETED: "OTP challenge is already completed.",
  OTP_VERIFICATION_REQUIRED: "OTP verification is required.",
  OTP_VERIFICATION_INVALID: "OTP verification is invalid.",
  OTP_VERIFICATION_EXPIRED: "OTP verification has expired.",
  OTP_VERIFICATION_ALREADY_USED: "OTP verification was already used.",
};
const grantIndexes = new WeakMap();
const systemClock = { now: () => new Date() };
let productionGrantsPromise;

export { isTransactionUnsupportedError };

export class OtpVerificationGrantError extends Error {
  constructor(code) {
    super(ERROR_MESSAGES[code] ?? ERROR_MESSAGES.OTP_VERIFICATION_INVALID);
    this.name = "OtpVerificationGrantError";
    this.code = code;
    this.status = COMPLETION_ERROR_CODES.has(code) ? 409 : 401;
  }
}

function grantError(code) {
  return new OtpVerificationGrantError(code);
}

function sessionOptions(session) {
  return session ? { session } : {};
}

function eligibleStatusFor(challenge) {
  if (challenge?.purpose !== "booking") {
    throw grantError("OTP_VERIFICATION_INVALID");
  }
  if (challenge.provider === "twilio") return "twilio_sent";
  if (challenge.provider === "firebase" || challenge.provider === "development") {
    return "pending";
  }
  throw grantError("OTP_VERIFICATION_INVALID");
}

function ensureGrantIndexes(grants) {
  if (!grantIndexes.has(grants)) {
    grantIndexes.set(
      grants,
      Promise.all([
        grants.createIndex(
          { tokenHash: 1 },
          { unique: true, name: "otp_grant_unique_tokenHash" },
        ),
        grants.createIndex(
          { challengeId: 1 },
          {
            unique: true,
            name: "otp_grant_unique_challenge",
            partialFilterExpression: { challengeId: { $type: "objectId" } },
          },
        ),
        grants.createIndex(
          { expiresAt: 1 },
          { expireAfterSeconds: 0, name: "otp_grant_expiresAt_ttl" },
        ),
      ]),
    );
  }
  return grantIndexes.get(grants);
}

async function getProductionGrantsCollection() {
  if (!productionGrantsPromise) {
    productionGrantsPromise = import("@/lib/db").then(({ getCollection }) =>
      getCollection(GRANT_COLLECTION_NAME),
    );
  }
  return productionGrantsPromise;
}

async function resolveIssueDependencies(deps) {
  let getMongoClient;
  if (!deps.client) {
    ({ getMongoClient } = await import("@/lib/db"));
  }
  const [challengeStore, grants, client] = await Promise.all([
    deps.challengeStore ?? getOtpChallengeStore(),
    deps.grants ?? getProductionGrantsCollection(),
    deps.client ?? getMongoClient(),
  ]);

  return { challengeStore, grants, client };
}

async function resolveGrantDependencies(deps) {
  let getCollection;
  if (!deps.challenges) {
    ({ getCollection } = await import("@/lib/db"));
  }
  const [challenges, grants] = await Promise.all([
    deps.challenges ?? getCollection(CHALLENGE_COLLECTION_NAME),
    deps.grants ?? getProductionGrantsCollection(),
  ]);
  return { challenges, grants };
}

async function readChallenge(challengeStore, challengeTokenHash, session) {
  return challengeStore.findByTokenHash(
    challengeTokenHash,
    sessionOptions(session),
  );
}

function challengeStateError(current) {
  if (current?.status === "completing") {
    return grantError("OTP_COMPLETION_IN_PROGRESS");
  }
  if (current?.status === "completed") {
    return grantError("OTP_CHALLENGE_ALREADY_COMPLETED");
  }
  return grantError("OTP_VERIFICATION_INVALID");
}

async function completeInTransaction({
  challenge,
  challengeTokenHash,
  eligibleStatus,
  completionId,
  tokenHash,
  challengeStore,
  grants,
  client,
  clock,
}) {
  let session;
  let grant;
  let error;
  let writeSucceeded = false;
  let commitConfirmed = false;
  let cleanupError;
  let attemptedGrant;

  try {
    session = client.startSession();
    grant = await session.withTransaction(async () => {
      const attemptNow = new Date(clock.now());
      const attemptGrant = buildGrant({
        challenge,
        completionId,
        tokenHash,
        now: attemptNow,
      });
      attemptedGrant = attemptGrant;
      const completed = await challengeStore.completeBooking(
        {
          challengeId: challenge._id,
          challengeTokenHash,
          provider: challenge.provider,
          eligibleStatus,
          completionId,
          now: attemptNow,
        },
        { session },
      );

      if (!completed) {
        const current = await readChallenge(
          challengeStore,
          challengeTokenHash,
          session,
        );
        throw challengeStateError(current);
      }

      writeSucceeded = true;
      await grants.deleteOne(
        {
          challengeId: challenge._id,
          completionId: { $ne: completionId },
        },
        { session },
      );
      await grants.insertOne(attemptGrant, { session });
      return attemptGrant;
    });
    commitConfirmed = true;
  } catch (caught) {
    error = caught;
  }

  if (session) {
    try {
      await session.endSession();
    } catch (caught) {
      cleanupError = caught;
    }
  }

  return {
    error,
    grant: grant ?? attemptedGrant,
    writeSucceeded,
    commitConfirmed,
    cleanupError,
  };
}

function idsEqual(left, right) {
  if (left === right) return true;
  if (typeof left?.equals === "function") return left.equals(right);
  if (typeof right?.equals === "function") return right.equals(left);
  return false;
}

function buildGrant({ challenge, completionId, tokenHash, now }) {
  return {
    challengeId: challenge._id,
    completionId,
    phone: challenge.phone,
    tokenHash,
    status: "prepared",
    used: false,
    usedAt: null,
    appointmentId: null,
    createdAt: now,
    expiresAt: new Date(now.getTime() + OTP_GRANT_TTL_MS),
  };
}

function completionMatches(challenge, completionId, tokenHash) {
  return (
    idsEqual(challenge?.completionId, completionId) &&
    challenge?.bookingGrantTokenHash === tokenHash
  );
}

function completedMatches(challenge, completionId) {
  return (
    challenge?.status === "completed" &&
    idsEqual(challenge.completionId, completionId)
  );
}

function validCompletionLease({ current, challenge, eligibleStatus }) {
  return (
    idsEqual(current?._id, challenge._id) &&
    current?.provider === challenge.provider &&
    current?.completionPreviousStatus === eligibleStatus &&
    current?.completionId &&
    current?.bookingGrantTokenHash
  );
}

function grantMatches(grant, { challenge, completionId, tokenHash }) {
  return (
    grant &&
    idsEqual(grant.challengeId, challenge._id) &&
    idsEqual(grant.completionId, completionId) &&
    grant.phone === challenge.phone &&
    grant.tokenHash === tokenHash &&
    grant.status === "prepared" &&
    grant.used === false
  );
}

function datesEqual(left, right) {
  return (
    left instanceof Date &&
    right instanceof Date &&
    Number.isFinite(left.getTime()) &&
    Number.isFinite(right.getTime()) &&
    left.getTime() === right.getTime()
  );
}

function exactUnusedGrantMatches(grant, expectedGrant) {
  return (
    grant &&
    (!expectedGrant._id || idsEqual(grant._id, expectedGrant._id)) &&
    idsEqual(grant.challengeId, expectedGrant.challengeId) &&
    idsEqual(grant.completionId, expectedGrant.completionId) &&
    grant.phone === expectedGrant.phone &&
    grant.tokenHash === expectedGrant.tokenHash &&
    grant.status === "prepared" &&
    grant.used === false &&
    grant.usedAt === null &&
    grant.appointmentId === null &&
    datesEqual(grant.createdAt, expectedGrant.createdAt) &&
    datesEqual(grant.expiresAt, expectedGrant.expiresAt)
  );
}

async function inspectTransactionDurability({
  challenge,
  challengeTokenHash,
  completionId,
  tokenHash,
  expectedGrant,
  challengeStore,
  grants,
  clock,
}) {
  const [current, grant] = await Promise.all([
    readChallenge(challengeStore, challengeTokenHash),
    grants.findOne({
      challengeId: challenge._id,
      completionId,
      tokenHash,
    }),
  ]);

  const exact =
    idsEqual(current?._id, challenge._id) &&
    completedMatches(current, completionId) &&
    exactUnusedGrantMatches(grant, expectedGrant);
  if (!exact) return { status: "mismatch" };

  const freshNow = new Date(clock.now());
  if (!Number.isFinite(freshNow.getTime())) return { status: "mismatch" };
  if (grant.expiresAt <= freshNow) {
    return { status: "expired", grant };
  }
  return { status: "durable", grant };
}

function exactExpiredGrantFilter(grant) {
  return {
    _id: grant._id,
    challengeId: grant.challengeId,
    completionId: grant.completionId,
    phone: grant.phone,
    tokenHash: grant.tokenHash,
    status: "prepared",
    used: false,
    usedAt: null,
    appointmentId: null,
    createdAt: grant.createdAt,
    expiresAt: grant.expiresAt,
  };
}

async function reissueExpiredGrant({
  challenge,
  challengeTokenHash,
  completionId,
  expiredGrant,
  challengeStore,
  grants,
  client,
  clock,
  tokenFactory,
  hashToken,
}) {
  const verificationToken = tokenFactory();
  const tokenHash = hashToken(verificationToken);
  if (!tokenHash || tokenHash === expiredGrant.tokenHash) {
    throw grantError("OTP_COMPLETION_IN_PROGRESS");
  }

  let session;
  let expectedGrant;
  let writeSucceeded = false;
  let commitConfirmed = false;
  let error;

  try {
    session = client.startSession();
    expectedGrant = await session.withTransaction(async () => {
      const current = await readChallenge(
        challengeStore,
        challengeTokenHash,
        session,
      );
      if (
        !idsEqual(current?._id, challenge._id) ||
        !completedMatches(current, completionId)
      ) {
        throw grantError("OTP_COMPLETION_IN_PROGRESS");
      }

      const attemptNow = new Date(clock.now());
      if (!Number.isFinite(attemptNow.getTime())) {
        throw grantError("OTP_COMPLETION_IN_PROGRESS");
      }
      const attemptGrant = {
        ...expiredGrant,
        tokenHash,
        createdAt: attemptNow,
        expiresAt: new Date(attemptNow.getTime() + OTP_GRANT_TTL_MS),
      };
      expectedGrant = attemptGrant;
      const updated = await grants.findOneAndUpdate(
        exactExpiredGrantFilter(expiredGrant),
        {
          $set: {
            tokenHash: attemptGrant.tokenHash,
            createdAt: attemptGrant.createdAt,
            expiresAt: attemptGrant.expiresAt,
          },
        },
        { session, returnDocument: "after" },
      );
      if (!exactUnusedGrantMatches(updated, attemptGrant)) {
        throw grantError("OTP_COMPLETION_IN_PROGRESS");
      }
      writeSucceeded = true;
      return attemptGrant;
    });
    commitConfirmed = true;
  } catch (caught) {
    error = caught;
  }

  if (session) {
    try {
      await session.endSession();
    } catch {
      // A confirmed commit is authoritative over session cleanup failure.
    }
  }

  if (commitConfirmed) return { verificationToken };
  if (writeSucceeded && expectedGrant) {
    let durability;
    try {
      durability = await inspectTransactionDurability({
        challenge,
        challengeTokenHash,
        completionId,
        tokenHash,
        expectedGrant,
        challengeStore,
        grants,
        clock,
      });
    } catch {
      durability = { status: "mismatch" };
    }
    if (durability.status === "durable") return { verificationToken };
  }
  throw error ?? grantError("OTP_COMPLETION_IN_PROGRESS");
}

function staleGrantDeleteFilter(grant, challengeId) {
  const identityFields = [
    "_id",
    "challengeId",
    "completionId",
    "phone",
    "tokenHash",
    "status",
    "used",
    "usedAt",
    "appointmentId",
    "createdAt",
    "expiresAt",
  ];
  if (
    !grant ||
    !idsEqual(grant.challengeId, challengeId) ||
    grant.status !== "prepared" ||
    identityFields.some(
      (field) => !Object.hasOwn(grant, field) || grant[field] === undefined,
    )
  ) {
    return null;
  }

  return Object.fromEntries(
    identityFields.map((field) => [field, grant[field]]),
  );
}

function isDuplicateKeyError(error) {
  return error?.code === 11000;
}

async function recoverExpiredLease({
  current,
  challenge,
  challengeTokenHash,
  eligibleStatus,
  challengeStore,
  grants,
  clock,
}) {
  if (current?.status !== "completing") return current;
  if (!validCompletionLease({ current, challenge, eligibleStatus })) {
    throw grantError("OTP_COMPLETION_IN_PROGRESS");
  }

  const recoveryNow = new Date(clock.now());
  const restored = await challengeStore.restoreCompletionLease({
    challengeId: challenge._id,
    challengeTokenHash,
    completionId: current.completionId,
    bookingGrantTokenHash: current.bookingGrantTokenHash,
    previousStatus: eligibleStatus,
    now: recoveryNow,
    expiredOnly: true,
  });
  if (!restored) {
    return readChallenge(challengeStore, challengeTokenHash);
  }

  await grants.deleteOne({
    challengeId: challenge._id,
    completionId: current.completionId,
    status: "prepared",
  });

  return restored;
}

async function compensateLease({
  challenge,
  challengeTokenHash,
  eligibleStatus,
  completionId,
  tokenHash,
  challengeStore,
  grants,
  now,
}) {
  let restored;
  try {
    restored = await challengeStore.restoreCompletionLease({
      challengeId: challenge._id,
      challengeTokenHash,
      completionId,
      bookingGrantTokenHash: tokenHash,
      previousStatus: eligibleStatus,
      now,
    });
  } catch (error) {
    throw new AggregateError(
      [error],
      "OTP completion compensation failed.",
    );
  }
  if (!restored) return false;

  try {
    await grants.deleteOne({
      challengeId: challenge._id,
      completionId,
      status: "prepared",
    });
  } catch (error) {
    throw new AggregateError(
      [error],
      "OTP completion compensation failed.",
    );
  }
  return true;
}

async function readGrantByChallenge(grants, challengeId) {
  return grants.findOne({ challengeId });
}

async function prepareLeaseGrant({
  challenge,
  challengeTokenHash,
  eligibleStatus,
  completionId,
  tokenHash,
  grant,
  preReservationGrant,
  challengeStore,
  grants,
  clock,
}) {
  try {
    if (
      preReservationGrant &&
      !idsEqual(preReservationGrant.completionId, completionId)
    ) {
      const deleteFilter = staleGrantDeleteFilter(
        preReservationGrant,
        challenge._id,
      );
      if (!deleteFilter) {
        throw grantError("OTP_COMPLETION_IN_PROGRESS");
      }
      const removed = await grants.deleteOne(deleteFilter);
      if (removed.deletedCount !== 1) {
        throw grantError("OTP_COMPLETION_IN_PROGRESS");
      }
    }

    const exactExisting = await grants.findOne({
      challengeId: challenge._id,
      completionId,
    });
    if (!exactExisting) {
      await grants.updateOne(
        { challengeId: challenge._id, completionId },
        { $setOnInsert: grant },
        { upsert: true },
      );
    }

    const prepared = await grants.findOne({
      challengeId: challenge._id,
      completionId,
      tokenHash,
      status: "prepared",
      used: false,
    });
    if (!grantMatches(prepared, { challenge, completionId, tokenHash })) {
      throw grantError("OTP_COMPLETION_IN_PROGRESS");
    }
    return prepared;
  } catch (error) {
    if (isDuplicateKeyError(error)) {
      const winner = await readGrantByChallenge(grants, challenge._id);
      if (grantMatches(winner, { challenge, completionId, tokenHash })) {
        return winner;
      }
    }

    try {
      await compensateLease({
        challenge,
        challengeTokenHash,
        eligibleStatus,
        completionId,
        tokenHash,
        challengeStore,
        grants,
        now: new Date(clock.now()),
      });
    } catch (compensationError) {
      throw new AggregateError(
        [error, compensationError],
        "OTP completion failed and compensation was incomplete.",
      );
    }

    if (isDuplicateKeyError(error)) {
      throw grantError("OTP_COMPLETION_IN_PROGRESS");
    }
    throw error;
  }
}

async function completeWithLease({
  challenge,
  challengeTokenHash,
  eligibleStatus,
  completionId,
  tokenHash,
  challengeStore,
  grants,
  clock,
}) {
  let current = await readChallenge(challengeStore, challengeTokenHash);
  current = await recoverExpiredLease({
    current,
    challenge,
    challengeTokenHash,
    eligibleStatus,
    challengeStore,
    grants,
    clock,
  });
  if (current?.status === "completed") throw challengeStateError(current);

  const preReservationGrant = await readGrantByChallenge(
    grants,
    challenge._id,
  );

  let reserved;
  let reservationTime;
  if (
    current?.status === "completing" &&
    validCompletionLease({ current, challenge, eligibleStatus }) &&
    completionMatches(current, completionId, tokenHash)
  ) {
    reserved = current;
    reservationTime =
      current.updatedAt instanceof Date
        ? current.updatedAt
        : new Date(clock.now());
  } else {
    reservationTime = new Date(clock.now());
    reserved = await challengeStore.reserveCompletionLease({
      challengeId: challenge._id,
      challengeTokenHash,
      provider: challenge.provider,
      eligibleStatus,
      completionId,
      bookingGrantTokenHash: tokenHash,
      now: reservationTime,
      leaseExpiresAt: new Date(
        reservationTime.getTime() + OTP_COMPLETION_LEASE_MS,
      ),
    });
  }
  if (!reserved) {
    const observed = await readChallenge(challengeStore, challengeTokenHash);
    if (
      observed?.status !== "completing" ||
      !validCompletionLease({ current: observed, challenge, eligibleStatus }) ||
      !completionMatches(observed, completionId, tokenHash)
    ) {
      throw challengeStateError(observed);
    }
    reserved = observed;
    reservationTime =
      observed.updatedAt instanceof Date
        ? observed.updatedAt
        : new Date(clock.now());
  }

  const grant = buildGrant({
    challenge,
    completionId,
    tokenHash,
    now: reservationTime,
  });
  await prepareLeaseGrant({
    challenge,
    challengeTokenHash,
    eligibleStatus,
    completionId,
    tokenHash,
    grant,
    preReservationGrant,
    challengeStore,
    grants,
    clock,
  });

  let completed;
  const finalizeNow = new Date(clock.now());
  try {
    completed = await challengeStore.finalizeCompletionLease({
      challengeId: challenge._id,
      challengeTokenHash,
      completionId,
      bookingGrantTokenHash: tokenHash,
      now: finalizeNow,
    });
  } catch {
    let observed;
    try {
      observed = await readChallenge(challengeStore, challengeTokenHash);
    } catch {
      // The prepared grant remains fail-closed until lease reconciliation.
    }
    if (completedMatches(observed, completionId)) return grant;
    throw grantError("OTP_COMPLETION_IN_PROGRESS");
  }

  if (completed) return grant;

  const observed = await readChallenge(challengeStore, challengeTokenHash);
  if (completedMatches(observed, completionId)) return grant;

  let compensated;
  try {
    compensated = await compensateLease({
      challenge,
      challengeTokenHash,
      eligibleStatus,
      completionId,
      tokenHash,
      challengeStore,
      grants,
      now: new Date(clock.now()),
    });
  } catch (compensationError) {
    throw new AggregateError(
      [grantError("OTP_VERIFICATION_INVALID"), compensationError],
      "OTP completion failed and compensation was incomplete.",
    );
  }

  if (!compensated) {
    const finalState = await readChallenge(challengeStore, challengeTokenHash);
    if (completedMatches(finalState, completionId)) return grant;
    throw grantError("OTP_COMPLETION_IN_PROGRESS");
  }
  throw grantError("OTP_VERIFICATION_INVALID");
}

export async function issueBookingGrant(
  { challenge, challengeTokenHash },
  deps = {},
) {
  const eligibleStatus = eligibleStatusFor(challenge);
  if (!challengeTokenHash) throw grantError("OTP_VERIFICATION_INVALID");

  const tokenFactory = deps.tokenFactory ?? createBearerToken;
  const hashToken = deps.hashToken ?? hashBearerToken;
  const completionIdFactory = deps.completionIdFactory ?? (() => new ObjectId());
  const clock = deps.clock ?? systemClock;
  const verificationToken = tokenFactory();
  const tokenHash = hashToken(verificationToken);
  const completionId = completionIdFactory();

  const { challengeStore, grants, client } =
    await resolveIssueDependencies(deps);
  await ensureGrantIndexes(grants);

  const transaction = await completeInTransaction({
    challenge,
    challengeTokenHash,
    eligibleStatus,
    completionId,
    tokenHash,
    challengeStore,
    grants,
    client,
    clock,
  });
  if (transaction.commitConfirmed) {
    return { verificationToken };
  }

  if (transaction.error) {
    if (transaction.writeSucceeded) {
      let durability = { status: "mismatch" };
      try {
        durability = await inspectTransactionDurability({
          challenge,
          challengeTokenHash,
          completionId,
          tokenHash,
          expectedGrant: transaction.grant,
          challengeStore,
          grants,
          clock,
        });
      } catch {
        durability = { status: "mismatch" };
      }
      if (durability.status === "durable") return { verificationToken };
      if (durability.status === "expired") {
        return reissueExpiredGrant({
          challenge,
          challengeTokenHash,
          completionId,
          expiredGrant: durability.grant,
          challengeStore,
          grants,
          client,
          clock,
          tokenFactory,
          hashToken,
        });
      }
    }

    if (
      !isTransactionUnsupportedError(transaction.error) ||
      transaction.writeSucceeded
    ) {
      throw transaction.error;
    }

    await completeWithLease({
      challenge,
      challengeTokenHash,
      eligibleStatus,
      completionId,
      tokenHash,
      challengeStore,
      grants,
      clock,
    });
  }

  return { verificationToken };
}

async function getGrantFailureCode({ grants, phone, tokenHash, now, session }) {
  const grant = await grants.findOne({ tokenHash }, sessionOptions(session));
  if (!grant || grant.phone !== phone || grant.status !== "prepared") {
    return "OTP_VERIFICATION_INVALID";
  }
  if (grant.used) return "OTP_VERIFICATION_ALREADY_USED";
  if (!(grant.expiresAt instanceof Date) || grant.expiresAt <= now) {
    return "OTP_VERIFICATION_EXPIRED";
  }
  return "OTP_VERIFICATION_INVALID";
}

async function readLinkedChallenge({ challenges, grant, session }) {
  if (!grant.challengeId || !grant.completionId) return null;
  return challenges.findOne(
    {
      _id: grant.challengeId,
      status: "completed",
      completionId: grant.completionId,
    },
    sessionOptions(session),
  );
}

export async function consumeBookingGrant(
  { phone, verificationToken, appointmentId, session },
  deps = {},
) {
  if (!verificationToken) {
    throw grantError("OTP_VERIFICATION_REQUIRED");
  }

  const hashToken = deps.hashToken ?? hashBearerToken;
  const clock = deps.clock ?? systemClock;
  const tokenHash = hashToken(verificationToken);
  const now = new Date(clock.now());
  const { challenges, grants } = await resolveGrantDependencies(deps);
  await ensureGrantIndexes(grants);

  const candidate = await grants.findOne(
    { tokenHash },
    sessionOptions(session),
  );
  if (!candidate || candidate.phone !== phone || candidate.status !== "prepared") {
    throw grantError("OTP_VERIFICATION_INVALID");
  }
  if (candidate.used) throw grantError("OTP_VERIFICATION_ALREADY_USED");
  if (!(candidate.expiresAt instanceof Date) || candidate.expiresAt <= now) {
    throw grantError("OTP_VERIFICATION_EXPIRED");
  }
  if (!(await readLinkedChallenge({ challenges, grant: candidate, session }))) {
    throw grantError("OTP_VERIFICATION_INVALID");
  }

  const consumed = await grants.findOneAndUpdate(
    {
      _id: candidate._id,
      challengeId: candidate.challengeId,
      completionId: candidate.completionId,
      phone,
      tokenHash,
      status: "prepared",
      used: false,
      expiresAt: { $gt: now },
    },
    {
      $set: {
        used: true,
        usedAt: now,
        appointmentId,
      },
    },
    {
      ...sessionOptions(session),
      returnDocument: "after",
    },
  );
  if (!consumed) {
    throw grantError(
      await getGrantFailureCode({
        grants,
        phone,
        tokenHash,
        now,
        session,
      }),
    );
  }
  return consumed;
}

export async function releaseBookingGrant(
  { phone, verificationToken, appointmentId, session },
  deps = {},
) {
  if (!verificationToken) return;

  const hashToken = deps.hashToken ?? hashBearerToken;
  const clock = deps.clock ?? systemClock;
  const tokenHash = hashToken(verificationToken);
  const now = new Date(clock.now());
  const { challenges, grants } = await resolveGrantDependencies(deps);
  await ensureGrantIndexes(grants);

  const candidate = await grants.findOne(
    {
      phone,
      tokenHash,
      status: "prepared",
      used: true,
      appointmentId,
      expiresAt: { $gt: now },
    },
    sessionOptions(session),
  );
  if (!candidate) return;
  if (!(await readLinkedChallenge({ challenges, grant: candidate, session }))) {
    return;
  }

  await grants.updateOne(
    {
      _id: candidate._id,
      challengeId: candidate.challengeId,
      completionId: candidate.completionId,
      phone,
      tokenHash,
      status: "prepared",
      used: true,
      appointmentId,
      expiresAt: { $gt: now },
    },
    {
      $set: {
        used: false,
        usedAt: null,
        appointmentId: null,
      },
    },
    sessionOptions(session),
  );
}
