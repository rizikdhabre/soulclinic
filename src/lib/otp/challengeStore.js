const ROTATION_RESIDUE = {
  fallbackReservedAt: "",
  lastFirebaseErrorCode: "",
  twilioSentAt: "",
  providerFinishedAt: "",
  completedAt: "",
  completionId: "",
  completionLeaseExpiresAt: "",
  completionPreviousStatus: "",
  bookingGrantTokenHash: "",
};

const COMPLETION_RESIDUE = {
  completionId: "",
  completionLeaseExpiresAt: "",
  completionPreviousStatus: "",
  bookingGrantTokenHash: "",
};

const LEASE_RESIDUE = {
  completionLeaseExpiresAt: "",
  completionPreviousStatus: "",
  bookingGrantTokenHash: "",
};

const MAX_TWILIO_SEND_ATTEMPTS = 3;
const SAFE_PROVIDER_SUMMARY_MAX_LENGTH = 64;
const SAFE_PROVIDER_SUMMARY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/-]*$/;

function assertProviderAttemptCount(value) {
  if (
    !Number.isInteger(value) ||
    value < 0 ||
    value > MAX_TWILIO_SEND_ATTEMPTS
  ) {
    throw new TypeError("Invalid provider attempt count.");
  }
}

function assertSafeProviderSummary(value) {
  if (value === null) return;
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > SAFE_PROVIDER_SUMMARY_MAX_LENGTH ||
    !SAFE_PROVIDER_SUMMARY_PATTERN.test(value)
  ) {
    throw new TypeError("Invalid provider summary code.");
  }
}

function sessionOptions(options = {}) {
  return options.session ? { session: options.session } : {};
}

function documentOrNull(document) {
  return document ?? null;
}

function activeChallengeFilter({
  challengeId,
  challengeTokenHash,
  purpose,
  provider,
  eligibleStatus,
  now,
}) {
  return {
    _id: challengeId,
    challengeTokenHash,
    ...(purpose === undefined ? {} : { purpose }),
    provider,
    status: eligibleStatus,
    expiresAt: { $gt: now },
  };
}

function activeTwilioSendingFilter({ challengeId, challengeTokenHash, now }) {
  return {
    _id: challengeId,
    challengeTokenHash,
    provider: "twilio",
    status: "twilio_sending",
    fallbackUsed: true,
    expiresAt: { $gt: now },
  };
}

export function createOtpChallengeStore({ collection }) {
  const indexesReady = Promise.all([
    collection.createIndex(
      { phone: 1, purpose: 1 },
      { unique: true, name: "otp_challenge_phone_purpose" },
    ),
    collection.createIndex(
      { challengeTokenHash: 1 },
      { unique: true, name: "otp_challenge_token_hash" },
    ),
    collection.createIndex(
      { expiresAt: 1 },
      { expireAfterSeconds: 0, name: "otp_challenge_expires_ttl" },
    ),
  ]);

  async function updateOneDocument(filter, update, options = {}) {
    await indexesReady;
    const document = await collection.findOneAndUpdate(filter, update, {
      ...sessionOptions(options),
      returnDocument: "after",
    });
    return documentOrNull(document);
  }

  return {
    ensureIndexes() {
      return indexesReady;
    },

    async findByTokenHash(challengeTokenHash, options = {}) {
      await indexesReady;
      const document = await collection.findOne(
        { challengeTokenHash },
        sessionOptions(options),
      );
      return documentOrNull(document);
    },

    async rotate(
      { phone, purpose, challengeTokenHash, provider, now, expiresAt },
      options = {},
    ) {
      await indexesReady;
      const document = await collection.findOneAndUpdate(
        { phone, purpose },
        {
          $set: {
            phone,
            purpose,
            challengeTokenHash,
            provider,
            status: "pending",
            fallbackUsed: false,
            providerAttemptCount: 0,
            lastProviderStatus: null,
            lastProviderErrorCode: null,
            createdAt: now,
            updatedAt: now,
            expiresAt,
          },
          $unset: ROTATION_RESIDUE,
        },
        {
          ...sessionOptions(options),
          upsert: true,
          returnDocument: "after",
        },
      );
      return documentOrNull(document);
    },

    async reserveFallback(
      { challengeId, challengeTokenHash, firebaseErrorCode, now },
      options = {},
    ) {
      assertSafeProviderSummary(firebaseErrorCode);
      return updateOneDocument(
        {
          _id: challengeId,
          challengeTokenHash,
          provider: "firebase",
          status: "pending",
          fallbackUsed: false,
          expiresAt: { $gt: now },
        },
        {
          $set: {
            provider: "twilio",
            status: "twilio_sending",
            fallbackUsed: true,
            fallbackReservedAt: now,
            lastFirebaseErrorCode: firebaseErrorCode,
            providerAttemptCount: 0,
            lastProviderStatus: null,
            lastProviderErrorCode: null,
            updatedAt: now,
          },
        },
        options,
      );
    },

    async markTwilioSent(
      {
        challengeId,
        challengeTokenHash,
        providerAttemptCount,
        lastProviderStatus,
        now,
      },
      options = {},
    ) {
      assertProviderAttemptCount(providerAttemptCount);
      assertSafeProviderSummary(lastProviderStatus);
      return updateOneDocument(
        activeTwilioSendingFilter({ challengeId, challengeTokenHash, now }),
        {
          $set: {
            status: "twilio_sent",
            providerAttemptCount,
            lastProviderStatus,
            lastProviderErrorCode: null,
            twilioSentAt: now,
            updatedAt: now,
          },
        },
        options,
      );
    },

    async markTwilioFailure(
      {
        challengeId,
        challengeTokenHash,
        status,
        providerAttemptCount,
        lastProviderStatus,
        lastProviderErrorCode,
        now,
      },
      options = {},
    ) {
      if (status !== "failed" && status !== "delivery_unknown") {
        throw new TypeError("Invalid Twilio failure status.");
      }
      assertProviderAttemptCount(providerAttemptCount);
      assertSafeProviderSummary(lastProviderStatus);
      assertSafeProviderSummary(lastProviderErrorCode);
      await indexesReady;

      const document = await collection.findOneAndUpdate(
        activeTwilioSendingFilter({ challengeId, challengeTokenHash, now }),
        {
          $set: {
            status,
            providerAttemptCount,
            lastProviderStatus,
            lastProviderErrorCode,
            providerFinishedAt: now,
            updatedAt: now,
          },
        },
        {
          ...sessionOptions(options),
          returnDocument: "after",
        },
      );
      return documentOrNull(document);
    },

    completeLogin(
      {
        challengeId,
        challengeTokenHash,
        provider,
        eligibleStatus,
        now,
      },
      options = {},
    ) {
      return updateOneDocument(
        activeChallengeFilter({
          challengeId,
          challengeTokenHash,
          purpose: "login",
          provider,
          eligibleStatus,
          now,
        }),
        {
          $set: { status: "completed", completedAt: now, updatedAt: now },
          $unset: COMPLETION_RESIDUE,
        },
        options,
      );
    },

    completeBooking(
      {
        challengeId,
        challengeTokenHash,
        provider,
        eligibleStatus,
        completionId,
        now,
      },
      options = {},
    ) {
      return updateOneDocument(
        activeChallengeFilter({
          challengeId,
          challengeTokenHash,
          provider,
          eligibleStatus,
          now,
        }),
        {
          $set: {
            status: "completed",
            completionId,
            completedAt: now,
            updatedAt: now,
          },
          $unset: LEASE_RESIDUE,
        },
        options,
      );
    },

    reserveCompletionLease(
      {
        challengeId,
        challengeTokenHash,
        provider,
        eligibleStatus,
        completionId,
        bookingGrantTokenHash,
        now,
        leaseExpiresAt,
      },
      options = {},
    ) {
      return updateOneDocument(
        activeChallengeFilter({
          challengeId,
          challengeTokenHash,
          provider,
          eligibleStatus,
          now,
        }),
        {
          $set: {
            status: "completing",
            completionId,
            completionPreviousStatus: eligibleStatus,
            completionLeaseExpiresAt: leaseExpiresAt,
            bookingGrantTokenHash,
            updatedAt: now,
          },
        },
        options,
      );
    },

    finalizeCompletionLease(
      { challengeId, challengeTokenHash, completionId, bookingGrantTokenHash, now },
      options = {},
    ) {
      return updateOneDocument(
        {
          _id: challengeId,
          challengeTokenHash,
          status: "completing",
          completionId,
          bookingGrantTokenHash,
          $expr: { $gt: ["$completionLeaseExpiresAt", "$$NOW"] },
        },
        {
          $set: { status: "completed", completedAt: now, updatedAt: now },
          $unset: LEASE_RESIDUE,
        },
        options,
      );
    },

    restoreCompletionLease(
      {
        challengeId,
        challengeTokenHash,
        completionId,
        bookingGrantTokenHash,
        previousStatus,
        now,
        expiredOnly = false,
      },
      options = {},
    ) {
      const filter = {
        _id: challengeId,
        challengeTokenHash,
        status: "completing",
        completionId,
        bookingGrantTokenHash,
        completionPreviousStatus: previousStatus,
      };
      if (expiredOnly) {
        filter.$expr = { $lte: ["$completionLeaseExpiresAt", "$$NOW"] };
      }

      return updateOneDocument(
        filter,
        {
          $set: { status: previousStatus, updatedAt: now },
          $unset: COMPLETION_RESIDUE,
        },
        options,
      );
    },
  };
}

let productionStorePromise;

export async function getOtpChallengeStore() {
  if (!productionStorePromise) {
    productionStorePromise = import("@/lib/db").then(({ getCollection }) =>
      getCollection("otpChallenges").then((collection) =>
        createOtpChallengeStore({ collection }),
      ),
    );
  }
  return productionStorePromise;
}
