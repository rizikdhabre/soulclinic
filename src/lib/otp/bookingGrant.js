import { ObjectId } from "mongodb";
import { isTransactionUnsupportedError } from "@/lib/mongoTransactions";
import { normalizeIsraeliPhone } from "@/lib/phone";
import { OTP_GRANT_TTL_MS } from "@/lib/otp/constants";
import { hashBearerToken } from "@/lib/otp/crypto";
import { getOtpChallengeStore } from "@/lib/otp/challengeStore";

const GRANT_COLLECTION_NAME = "otpVerificationGrants";
const CHALLENGE_COLLECTION_NAME = "otpChallengesV2";
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

function issueReadOptions(session) {
  return session ? { session } : {
    readPreference: "primary",
    readConcern: { level: "majority" },
  };
}

function issueWriteOptions(session) {
  return session ? { session } : { writeConcern: { w: "majority" } };
}

function validDate(value) {
  return value instanceof Date && Number.isFinite(value.getTime());
}

function datesEqual(left, right) {
  return validDate(left) && validDate(right) && left.getTime() === right.getTime();
}

function idsEqual(left, right) {
  return left instanceof ObjectId && right instanceof ObjectId && left.equals(right);
}

function nonemptyString(value) {
  return typeof value === "string" && value.length > 0 && value.trim() === value;
}

function nowFrom(clock) {
  const now = new Date(clock.now());
  if (!validDate(now)) throw grantError("OTP_VERIFICATION_INVALID");
  return now;
}

function ensureGrantIndexes(grants) {
  if (!grantIndexes.has(grants)) {
    const ready = Promise.all([
      grants.createIndex({ tokenHash: 1 }, { unique: true, name: "otp_grant_unique_tokenHash" }),
      grants.createIndex({ challengeId: 1 }, {
        unique: true,
        name: "otp_grant_unique_challenge",
        partialFilterExpression: { challengeId: { $type: "objectId" } },
      }),
      grants.createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0, name: "otp_grant_expiresAt_ttl" }),
    ]).catch((error) => {
      grantIndexes.delete(grants);
      throw error;
    });
    grantIndexes.set(grants, ready);
  }
  return grantIndexes.get(grants);
}

async function getProductionGrantsCollection() {
  if (!productionGrantsPromise) {
    productionGrantsPromise = import("@/lib/db")
      .then(({ getCollection }) => getCollection(GRANT_COLLECTION_NAME))
      .catch((error) => { productionGrantsPromise = null; throw error; });
  }
  return productionGrantsPromise;
}

async function resolveIssueDependencies(deps) {
  const challengeStore = deps.challengeStore ?? await getOtpChallengeStore();
  const grants = deps.grants ?? await getProductionGrantsCollection();
  const client = deps.client ?? await (await import("@/lib/db")).getMongoClient();
  await challengeStore.ensureIndexes();
  await ensureGrantIndexes(grants);
  return { challengeStore, grants, client };
}

async function resolveGrantDependencies(deps) {
  const challenges = deps.challenges ??
    await (await import("@/lib/db")).getCollection(CHALLENGE_COLLECTION_NAME);
  const grants = deps.grants ?? await getProductionGrantsCollection();
  await ensureGrantIndexes(grants);
  return { challenges, grants };
}

function validateChallenge(challenge, challengeTokenHash, now) {
  if (
    !(challenge?._id instanceof ObjectId) ||
    !nonemptyString(challengeTokenHash) ||
    challenge.challengeTokenHash !== challengeTokenHash ||
    !["twilio", "firebase"].includes(challenge.provider) || challenge.purpose !== "booking" ||
    !["approved", "completed"].includes(challenge.status) ||
    !nonemptyString(challenge.phone) || normalizeIsraeliPhone(challenge.phone) !== challenge.phone ||
    !validDate(challenge.approvedAt) || challenge.approvedAt > now ||
    !validDate(challenge.expiresAt) || !validDate(challenge.completionExpiresAt) ||
    challenge.completionExpiresAt.getTime() !== challenge.approvedAt.getTime() + OTP_GRANT_TTL_MS
  ) {
    throw grantError("OTP_VERIFICATION_INVALID");
  }
  if (challenge.completionExpiresAt <= now) throw grantError("OTP_VERIFICATION_EXPIRED");
}

function challengeIdentity(challenge) {
  return {
    _id: challenge._id,
    challengeTokenHash: challenge.challengeTokenHash,
    provider: challenge.provider,
    purpose: "booking",
    phone: challenge.phone,
    approvedAt: challenge.approvedAt,
    completionExpiresAt: challenge.completionExpiresAt,
    expiresAt: challenge.expiresAt,
  };
}

function assertCurrentChallenge(current, context) {
  const { challenge, challengeTokenHash, expectedGrant, clock } = context;
  validateChallenge(current, challengeTokenHash, nowFrom(clock));
  if (
    !idsEqual(current._id, challenge._id) || current.phone !== challenge.phone || current.provider !== challenge.provider ||
    !datesEqual(current.approvedAt, challenge.approvedAt) ||
    !datesEqual(current.completionExpiresAt, challenge.completionExpiresAt) ||
    !datesEqual(current.expiresAt, challenge.expiresAt) ||
    (current.status === "completed" && (
      !idsEqual(current.completionId, expectedGrant.completionId) ||
      current.bookingGrantTokenHash !== expectedGrant.tokenHash
    ))
  ) {
    throw grantError("OTP_VERIFICATION_INVALID");
  }
}

function buildGrant(challenge, tokenHash) {
  return {
    challengeId: challenge._id,
    completionId: challenge._id,
    phone: challenge.phone,
    purpose: "booking",
    tokenHash,
    status: "prepared",
    used: false,
    usedAt: null,
    appointmentId: null,
    createdAt: challenge.approvedAt,
    expiresAt: challenge.completionExpiresAt,
  };
}

function assertUnusedGrant(grant, phone, now) {
  if (!grant || grant.phone !== phone || grant.purpose !== "booking" || grant.status !== "prepared") {
    throw grantError("OTP_VERIFICATION_INVALID");
  }
  if (grant.used === true) throw grantError("OTP_VERIFICATION_ALREADY_USED");
  if (!validDate(grant.expiresAt) || grant.expiresAt <= now) {
    throw grantError("OTP_VERIFICATION_EXPIRED");
  }
  if (grant.used !== false || grant.usedAt !== null || grant.appointmentId !== null) {
    throw grantError("OTP_VERIFICATION_INVALID");
  }
}

function assertExactGrant(grant, expected, now) {
  if (
    !grant || !idsEqual(grant.challengeId, expected.challengeId) ||
    !idsEqual(grant.completionId, expected.completionId) ||
    grant.tokenHash !== expected.tokenHash ||
    !datesEqual(grant.createdAt, expected.createdAt) ||
    !datesEqual(grant.expiresAt, expected.expiresAt)
  ) {
    throw grantError("OTP_VERIFICATION_INVALID");
  }
  assertUnusedGrant(grant, expected.phone, now);
}

async function readCurrentChallenge(context, session) {
  const current = await context.challengeStore.findByTokenHash(
    context.challengeTokenHash, issueReadOptions(session),
  );
  assertCurrentChallenge(current, context);
  return current;
}

async function readExactGrant(context, session) {
  const grant = await context.grants.findOne(
    { challengeId: context.challenge._id }, issueReadOptions(session),
  );
  assertExactGrant(grant, context.expectedGrant, nowFrom(context.clock));
  return grant;
}

async function inspectPublished(context, session) {
  const current = await readCurrentChallenge(context, session);
  if (current.status !== "completed") return false;
  // Read the grant last so concurrent consumption cannot be hidden by an old grant read.
  await readExactGrant(context, session);
  return true;
}

async function prepareAndPublish(context, session) {
  const current = await readCurrentChallenge(context, session);
  if (current.status === "completed") {
    await readExactGrant(context, session);
    return;
  }
  const { grants, expectedGrant, challengeStore, challengeTokenHash, challenge, clock } = context;
  const existing = await grants.findOne({ challengeId: challenge._id }, issueReadOptions(session));
  if (existing) assertExactGrant(existing, expectedGrant, nowFrom(clock));

  // Exact $setOnInsert never rotates, resets, or deletes a competing request's grant.
  context.writeStarted = true;
  try {
    await grants.updateOne(expectedGrant, { $setOnInsert: expectedGrant }, {
      ...issueWriteOptions(session), upsert: true,
    });
  } catch (error) {
    if (error?.code !== 11000 || session) throw error;
    await readExactGrant(context);
  }
  await readExactGrant(context, session);
  const now = nowFrom(clock);
  validateChallenge(challenge, challengeTokenHash, now);
  const completed = await challengeStore.transition({
    challengeTokenHash,
    provider: challenge.provider,
    from: "approved",
    now,
    match: {
      ...challengeIdentity(challenge),
      completionExpiresAt: { $gt: now },
      $expr: { $eq: ["$completionExpiresAt", challenge.completionExpiresAt] },
    },
    patch: {
      status: "completed",
      completionId: expectedGrant.completionId,
      bookingGrantTokenHash: expectedGrant.tokenHash,
      completedAt: now,
    },
  }, issueWriteOptions(session));
  if (completed) assertCurrentChallenge(completed, context);
  if (!(await inspectPublished(context, session))) {
    throw grantError("OTP_COMPLETION_IN_PROGRESS");
  }
}

export async function issueBookingGrant(
  { challenge, challengeTokenHash, verificationToken }, deps = {},
) {
  const clock = deps.clock ?? systemClock;
  validateChallenge(challenge, challengeTokenHash, nowFrom(clock));
  if (!nonemptyString(verificationToken)) throw grantError("OTP_VERIFICATION_INVALID");
  const tokenHash = (deps.hashToken ?? hashBearerToken)(verificationToken);
  if (!nonemptyString(tokenHash)) throw grantError("OTP_VERIFICATION_INVALID");
  const dependencies = await resolveIssueDependencies(deps);
  const context = {
    ...dependencies, challenge, challengeTokenHash, clock,
    expectedGrant: buildGrant(challenge, tokenHash), writeStarted: false,
  };

  let session;
  let failure;
  try {
    session = dependencies.client.startSession();
    await session.withTransaction(() => prepareAndPublish(context, session), {
      readConcern: { level: "snapshot" }, writeConcern: { w: "majority" }, readPreference: "primary",
    });
  } catch (error) {
    failure = error;
  } finally {
    try {
      await session?.endSession();
    } catch {
      // Session cleanup cannot undo a commit; durable records decide the result.
    }
  }

  if (failure && !context.writeStarted && isTransactionUnsupportedError(failure)) {
    try {
      await prepareAndPublish(context);
      failure = undefined;
    } catch (error) {
      failure = error;
    }
  }

  try {
    if (await inspectPublished(context)) return { verificationToken };
  } catch (error) {
    if (error instanceof OtpVerificationGrantError || !failure) throw error;
    throw failure;
  }
  if (failure?.code === 11000) throw grantError("OTP_COMPLETION_IN_PROGRESS");
  throw failure ?? grantError("OTP_COMPLETION_IN_PROGRESS");
}

async function readLinkedChallenge({ challenges, grant, session }) {
  if (
    !idsEqual(grant.challengeId, grant.completionId) || grant.purpose !== "booking" ||
    !validDate(grant.createdAt) || !validDate(grant.expiresAt) ||
    grant.expiresAt.getTime() !== grant.createdAt.getTime() + OTP_GRANT_TTL_MS
  ) return null;
  return challenges.findOne({
    _id: grant.challengeId,
    provider: { $in: ["twilio", "firebase"] },
    purpose: "booking",
    phone: grant.phone,
    status: "completed",
    completionId: grant.completionId,
    bookingGrantTokenHash: grant.tokenHash,
    approvedAt: grant.createdAt,
    completionExpiresAt: grant.expiresAt,
  }, issueReadOptions(session));
}

function grantUpdateFilter(grant, now) {
  return {
    _id: grant._id,
    challengeId: grant.challengeId,
    completionId: grant.completionId,
    phone: grant.phone,
    purpose: "booking",
    tokenHash: grant.tokenHash,
    status: "prepared",
    used: grant.used,
    usedAt: grant.usedAt,
    appointmentId: grant.appointmentId,
    createdAt: grant.createdAt,
    expiresAt: { $gt: now },
    $expr: { $eq: ["$expiresAt", grant.expiresAt] },
  };
}

export async function consumeBookingGrant(
  { phone, verificationToken, appointmentId, session }, deps = {},
) {
  if (!verificationToken) throw grantError("OTP_VERIFICATION_REQUIRED");
  if (!nonemptyString(verificationToken)) throw grantError("OTP_VERIFICATION_INVALID");
  const tokenHash = (deps.hashToken ?? hashBearerToken)(verificationToken);
  const clock = deps.clock ?? systemClock;
  const { challenges, grants } = await resolveGrantDependencies(deps);
  const candidate = await grants.findOne({ tokenHash }, issueReadOptions(session));
  assertUnusedGrant(candidate, phone, nowFrom(clock));
  if (!(await readLinkedChallenge({ challenges, grant: candidate, session }))) {
    throw grantError("OTP_VERIFICATION_INVALID");
  }
  const now = nowFrom(clock);
  assertUnusedGrant(candidate, phone, now);
  const consumed = await grants.findOneAndUpdate(grantUpdateFilter(candidate, now), {
    $set: { used: true, usedAt: now, appointmentId },
  }, { ...issueWriteOptions(session), returnDocument: "after" });
  if (!consumed) {
    const current = await grants.findOne({ tokenHash }, issueReadOptions(session));
    assertUnusedGrant(current, phone, nowFrom(clock));
    throw grantError("OTP_VERIFICATION_INVALID");
  }
  return consumed;
}

export async function releaseBookingGrant(
  { phone, verificationToken, appointmentId, session }, deps = {},
) {
  if (!nonemptyString(verificationToken)) return;
  const tokenHash = (deps.hashToken ?? hashBearerToken)(verificationToken);
  const clock = deps.clock ?? systemClock;
  const { challenges, grants } = await resolveGrantDependencies(deps);
  const candidate = await grants.findOne({
    phone, tokenHash, purpose: "booking", status: "prepared", used: true,
    appointmentId, expiresAt: { $gt: nowFrom(clock) },
  }, issueReadOptions(session));
  if (!candidate || !(await readLinkedChallenge({ challenges, grant: candidate, session }))) return;
  await grants.updateOne(grantUpdateFilter(candidate, nowFrom(clock)), {
    $set: { used: false, usedAt: null, appointmentId: null },
  }, issueWriteOptions(session));
}
