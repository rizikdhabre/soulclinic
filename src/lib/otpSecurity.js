import crypto from "crypto";
import { ObjectId } from "mongodb";
import { getCollection } from "./db";

export const OTP_SEND_COOLDOWN_SECONDS = 60;
export const OTP_SEND_HOURLY_LIMIT = 5;
export const OTP_SEND_HOURLY_WINDOW_MS = 60 * 60 * 1000;
export const OTP_VERIFY_FAILURE_LIMIT = 5;
export const OTP_VERIFY_FAILURE_WINDOW_MS = 10 * 60 * 1000;
export const OTP_GRANT_TTL_SECONDS = 10 * 60;

const OTP_RECORD_RETENTION_MS = 3 * 24 * 60 * 60 * 1000;
const OTP_ACTIVE_OPERATION_STALE_MS = 2 * 60 * 1000;
const OTP_ACTIVE_STATUSES = ["PENDING", "RETRY_WAIT", "SENDING"];
const OTP_HOURLY_COUNT_STATUSES = [
  "PENDING",
  "RETRY_WAIT",
  "SENDING",
  "SENT",
  "FAILED",
  "UNKNOWN",
];

let otpIndexesPromise = null;

export function getRetryAfterSeconds(targetDate, now = new Date()) {
  const targetTime = targetDate instanceof Date ? targetDate.getTime() : 0;
  return Math.max(1, Math.ceil((targetTime - now.getTime()) / 1000));
}

export function maskPhone(phone) {
  if (!phone || phone.length < 6) return "***";
  return `${phone.slice(0, 4)}***${phone.slice(-2)}`;
}

function addMilliseconds(date, ms) {
  return new Date(date.getTime() + ms);
}

function isDuplicateKeyError(error) {
  return error?.code === 11000;
}

export function hashVerificationToken(token) {
  return crypto.createHash("sha256").update(String(token)).digest("hex");
}

export async function ensureOtpIndexes() {
  if (!otpIndexesPromise) {
    otpIndexesPromise = (async () => {
      const sendOperations = await getCollection("otpSendOperations");
      const providerAttempts = await getCollection("otpProviderAttempts");
      const verificationGrants = await getCollection("otpVerificationGrants");
      const verifyFailures = await getCollection("otpVerifyFailures");

      await Promise.all([
        sendOperations.createIndex(
          { phone: 1, startedAt: -1 },
          { name: "otp_send_phone_startedAt" },
        ),
        sendOperations.createIndex(
          { phone: 1, status: 1 },
          { name: "otp_send_phone_status" },
        ),
        sendOperations.createIndex(
          { expiresAt: 1 },
          { name: "otp_send_expiresAt_ttl", expireAfterSeconds: 0 },
        ),
        sendOperations.createIndex(
          { phone: 1 },
          {
            name: "otp_send_unique_active_phone",
            unique: true,
            partialFilterExpression: { active: true },
          },
        ),
        providerAttempts.createIndex(
          { operationId: 1, attemptNumber: 1 },
          { name: "otp_provider_operation_attempt", unique: true },
        ),
        providerAttempts.createIndex(
          { expiresAt: 1 },
          { name: "otp_provider_expiresAt_ttl", expireAfterSeconds: 0 },
        ),
        verificationGrants.createIndex(
          { tokenHash: 1 },
          { name: "otp_grant_unique_tokenHash", unique: true },
        ),
        verificationGrants.createIndex(
          { phone: 1, used: 1, expiresAt: 1 },
          { name: "otp_grant_phone_used_expiresAt" },
        ),
        verificationGrants.createIndex(
          { expiresAt: 1 },
          { name: "otp_grant_expiresAt_ttl", expireAfterSeconds: 0 },
        ),
        verifyFailures.createIndex(
          { phone: 1, createdAt: -1 },
          { name: "otp_verify_failures_phone_createdAt" },
        ),
        verifyFailures.createIndex(
          { expiresAt: 1 },
          { name: "otp_verify_failures_expiresAt_ttl", expireAfterSeconds: 0 },
        ),
      ]);
    })().catch((error) => {
      otpIndexesPromise = null;
      throw error;
    });
  }

  return otpIndexesPromise;
}

async function getOtpSendOperationsCollection() {
  await ensureOtpIndexes();
  return getCollection("otpSendOperations");
}

async function getOtpProviderAttemptsCollection() {
  await ensureOtpIndexes();
  return getCollection("otpProviderAttempts");
}

async function getOtpVerificationGrantsCollection() {
  await ensureOtpIndexes();
  return getCollection("otpVerificationGrants");
}

async function getOtpVerifyFailuresCollection() {
  await ensureOtpIndexes();
  return getCollection("otpVerifyFailures");
}

async function releaseStaleActiveOperation(collection, phone, now) {
  const staleBefore = addMilliseconds(now, -OTP_ACTIVE_OPERATION_STALE_MS);

  await collection.updateMany(
    {
      phone,
      active: true,
      status: { $in: OTP_ACTIVE_STATUSES },
      updatedAt: { $lt: staleBefore },
    },
    {
      $set: {
        active: false,
        status: "UNKNOWN",
        errorCode: "OTP_SEND_PENDING",
        errorCategory: "STALE_OPERATION",
        updatedAt: now,
        completedAt: now,
      },
    },
  );
}

async function recordBlockedSendOperation(collection, phone, errorCode, now) {
  await collection.insertOne({
    _id: new ObjectId(),
    phone,
    userRequestId: crypto.randomUUID(),
    userRequest: true,
    status: "BLOCKED",
    active: false,
    provider: null,
    providerAttempts: 0,
    startedAt: now,
    updatedAt: now,
    completedAt: now,
    cooldownUntil: now,
    expiresAt: addMilliseconds(now, OTP_RECORD_RETENTION_MS),
    errorCode,
    errorCategory: "USER_LIMIT",
  });
}

export async function claimOtpSendOperation(phone) {
  const collection = await getOtpSendOperationsCollection();
  const now = new Date();

  await releaseStaleActiveOperation(collection, phone, now);

  const activeOperation = await collection.findOne({
    phone,
    active: true,
    status: { $in: OTP_ACTIVE_STATUSES },
  });

  if (activeOperation) {
    return {
      ok: false,
      error: "OTP_REQUEST_IN_PROGRESS",
      status: 409,
      retryAfterSeconds: Math.min(
        10,
        getRetryAfterSeconds(activeOperation.cooldownUntil || addMilliseconds(now, 10000), now),
      ),
      operation: activeOperation,
    };
  }

  const coolingOperation = await collection.findOne(
    {
      phone,
      status: { $in: OTP_HOURLY_COUNT_STATUSES },
      cooldownUntil: { $gt: now },
    },
    { sort: { cooldownUntil: -1 } },
  );

  if (coolingOperation) {
    return {
      ok: false,
      error: "OTP_RATE_LIMITED",
      status: 429,
      retryAfterSeconds: getRetryAfterSeconds(coolingOperation.cooldownUntil, now),
      operation: coolingOperation,
    };
  }

  const hourAgo = addMilliseconds(now, -OTP_SEND_HOURLY_WINDOW_MS);
  const hourlyCount = await collection.countDocuments({
    phone,
    userRequest: true,
    status: { $in: OTP_HOURLY_COUNT_STATUSES },
    startedAt: { $gte: hourAgo },
  });

  if (hourlyCount >= OTP_SEND_HOURLY_LIMIT) {
    const oldestRecentOperation = await collection.findOne(
      {
        phone,
        userRequest: true,
        status: { $in: OTP_HOURLY_COUNT_STATUSES },
        startedAt: { $gte: hourAgo },
      },
      { sort: { startedAt: 1 } },
    );
    const retryAt = addMilliseconds(
      oldestRecentOperation?.startedAt || now,
      OTP_SEND_HOURLY_WINDOW_MS,
    );

    await recordBlockedSendOperation(collection, phone, "OTP_RATE_LIMITED", now);

    return {
      ok: false,
      error: "OTP_RATE_LIMITED",
      status: 429,
      retryAfterSeconds: getRetryAfterSeconds(retryAt, now),
    };
  }

  const operation = {
    _id: new ObjectId(),
    phone,
    userRequestId: crypto.randomUUID(),
    userRequest: true,
    status: "PENDING",
    active: true,
    provider: null,
    providerAttempts: 0,
    startedAt: now,
    updatedAt: now,
    lastAttemptAt: null,
    completedAt: null,
    cooldownUntil: addMilliseconds(now, OTP_SEND_COOLDOWN_SECONDS * 1000),
    expiresAt: addMilliseconds(now, OTP_RECORD_RETENTION_MS),
    providerStatus: null,
    errorCode: null,
    errorCategory: null,
  };

  try {
    await collection.insertOne(operation);
  } catch (error) {
    if (!isDuplicateKeyError(error)) throw error;

    const existing = await collection.findOne({
      phone,
      active: true,
      status: { $in: OTP_ACTIVE_STATUSES },
    });

    return {
      ok: false,
      error: "OTP_REQUEST_IN_PROGRESS",
      status: 409,
      retryAfterSeconds: 10,
      operation: existing,
    };
  }

  return { ok: true, operation };
}

export async function updateOtpSendOperation(operationId, update) {
  const collection = await getOtpSendOperationsCollection();
  const now = new Date();

  await collection.updateOne(
    { _id: operationId },
    {
      $set: {
        ...update,
        updatedAt: now,
      },
    },
  );
}

export async function startOtpProviderAttempt({
  operationId,
  phone,
  attemptNumber,
  provider,
}) {
  const attemptsCollection = await getOtpProviderAttemptsCollection();
  const operationsCollection = await getOtpSendOperationsCollection();
  const now = new Date();
  const attempt = {
    _id: new ObjectId(),
    operationId,
    phone,
    attemptNumber,
    status: "STARTED",
    provider,
    startedAt: now,
    completedAt: null,
    providerHttpStatus: null,
    providerErrorCode: null,
    errorCategory: null,
    retryable: null,
    expiresAt: addMilliseconds(now, OTP_RECORD_RETENTION_MS),
  };

  await attemptsCollection.insertOne(attempt);
  await operationsCollection.updateOne(
    { _id: operationId },
    {
      $set: {
        status: "SENDING",
        provider,
        providerAttempts: attemptNumber,
        lastAttemptAt: now,
        updatedAt: now,
      },
    },
  );

  return attempt;
}

export async function completeOtpProviderAttempt(attemptId, update) {
  const collection = await getOtpProviderAttemptsCollection();
  const now = new Date();

  await collection.updateOne(
    { _id: attemptId },
    {
      $set: {
        ...update,
        completedAt: now,
      },
    },
  );
}

export async function completeOtpSendOperation(operationId, update) {
  const collection = await getOtpSendOperationsCollection();
  const now = new Date();

  await collection.updateOne(
    { _id: operationId },
    {
      $set: {
        ...update,
        active: false,
        updatedAt: now,
        completedAt: now,
      },
    },
  );
}

export async function setOtpSendRetryWait(operationId, update = {}) {
  const collection = await getOtpSendOperationsCollection();
  const now = new Date();

  await collection.updateOne(
    { _id: operationId },
    {
      $set: {
        ...update,
        status: "RETRY_WAIT",
        active: true,
        updatedAt: now,
      },
    },
  );
}

export async function getRecentOtpVerifyFailureLimit(phone) {
  const collection = await getOtpVerifyFailuresCollection();
  const now = new Date();
  const windowStart = addMilliseconds(now, -OTP_VERIFY_FAILURE_WINDOW_MS);
  const count = await collection.countDocuments({
    phone,
    createdAt: { $gte: windowStart },
    expiresAt: { $gt: now },
  });

  if (count < OTP_VERIFY_FAILURE_LIMIT) {
    return { limited: false, remaining: OTP_VERIFY_FAILURE_LIMIT - count };
  }

  const oldestRecentFailure = await collection.findOne(
    {
      phone,
      createdAt: { $gte: windowStart },
      expiresAt: { $gt: now },
    },
    { sort: { createdAt: 1 } },
  );
  const retryAt = addMilliseconds(
    oldestRecentFailure?.createdAt || now,
    OTP_VERIFY_FAILURE_WINDOW_MS,
  );

  return {
    limited: true,
    retryAfterSeconds: getRetryAfterSeconds(retryAt, now),
  };
}

export async function recordOtpVerifyFailure(phone, errorCode = "INVALID_OTP") {
  const collection = await getOtpVerifyFailuresCollection();
  const now = new Date();

  await collection.insertOne({
    _id: new ObjectId(),
    phone,
    createdAt: now,
    errorCode,
    expiresAt: addMilliseconds(now, OTP_VERIFY_FAILURE_WINDOW_MS),
  });
}

export async function clearOtpVerifyFailures(phone) {
  const collection = await getOtpVerifyFailuresCollection();
  await collection.deleteMany({ phone });
}

export async function createOtpVerificationGrant(phone) {
  const collection = await getOtpVerificationGrantsCollection();
  const now = new Date();
  const verificationToken = crypto.randomBytes(32).toString("base64url");
  const tokenHash = hashVerificationToken(verificationToken);
  const expiresAt = addMilliseconds(now, OTP_GRANT_TTL_SECONDS * 1000);

  await collection.insertOne({
    _id: new ObjectId(),
    phone,
    tokenHash,
    createdAt: now,
    expiresAt,
    used: false,
    usedAt: null,
    appointmentId: null,
  });

  return {
    verificationToken,
    expiresInSeconds: OTP_GRANT_TTL_SECONDS,
    expiresAt,
  };
}

export class OtpVerificationGrantError extends Error {
  constructor(code, message = "OTP verification is required.") {
    super(message);
    this.name = "OtpVerificationGrantError";
    this.code = code;
    this.status = 401;
  }
}

async function getGrantFailureCode({ collection, phone, tokenHash, now, session }) {
  const grant = await collection.findOne(
    { tokenHash },
    { ...(session ? { session } : {}) },
  );

  if (!grant || grant.phone !== phone) return "OTP_VERIFICATION_INVALID";
  if (grant.used) return "OTP_VERIFICATION_ALREADY_USED";
  if (grant.expiresAt <= now) return "OTP_VERIFICATION_EXPIRED";
  return "OTP_VERIFICATION_INVALID";
}

export async function consumeOtpVerificationGrant({
  phone,
  verificationToken,
  appointmentId,
  session,
}) {
  if (!verificationToken) {
    throw new OtpVerificationGrantError(
      "OTP_VERIFICATION_REQUIRED",
      "OTP verification is required.",
    );
  }

  const collection = await getOtpVerificationGrantsCollection();
  const now = new Date();
  const tokenHash = hashVerificationToken(verificationToken);
  const updateResult = await collection.findOneAndUpdate(
    {
      phone,
      tokenHash,
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
      returnDocument: "after",
      ...(session ? { session } : {}),
    },
  );
  const grant = updateResult?.value ?? updateResult;

  if (!grant) {
    const code = await getGrantFailureCode({
      collection,
      phone,
      tokenHash,
      now,
      session,
    });
    throw new OtpVerificationGrantError(code, "OTP verification is invalid.");
  }

  return grant;
}

export async function releaseOtpVerificationGrant({
  phone,
  verificationToken,
  appointmentId,
}) {
  if (!verificationToken) return;

  const collection = await getOtpVerificationGrantsCollection();
  const tokenHash = hashVerificationToken(verificationToken);

  await collection.updateOne(
    {
      phone,
      tokenHash,
      used: true,
      appointmentId,
    },
    {
      $set: {
        used: false,
        usedAt: null,
        appointmentId: null,
      },
    },
  );
}
