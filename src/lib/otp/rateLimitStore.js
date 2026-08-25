import {
  OTP_PHONE_START_COOLDOWN_MS,
  OTP_PHONE_START_WINDOW_LIMIT,
  OTP_PHONE_START_WINDOW_MS,
  OTP_PHONE_VERIFY_FAILURE_LIMIT,
  OTP_PHONE_VERIFY_WINDOW_MS,
  OTP_SOURCE_CHALLENGE_HOUR_LIMIT,
  OTP_SOURCE_CHALLENGE_SHORT_LIMIT,
  OTP_SOURCE_FALLBACK_HOUR_LIMIT,
  OTP_SOURCE_FALLBACK_SHORT_LIMIT,
  OTP_SOURCE_HOUR_WINDOW_MS,
  OTP_SOURCE_SHORT_WINDOW_MS,
  OTP_STATE_CAS_MAX_ATTEMPTS,
  OTP_STATE_RETENTION_MS,
} from "./constants";
import { OtpError } from "./errors";

const SOURCE_POLICIES = {
  challenge: {
    prefix: "challenge",
    shortLimit: OTP_SOURCE_CHALLENGE_SHORT_LIMIT,
    hourLimit: OTP_SOURCE_CHALLENGE_HOUR_LIMIT,
    code: "OTP_SOURCE_RATE_LIMITED",
    message: "OTP challenge rate limit exceeded.",
  },
  fallback: {
    prefix: "fallback",
    shortLimit: OTP_SOURCE_FALLBACK_SHORT_LIMIT,
    hourLimit: OTP_SOURCE_FALLBACK_HOUR_LIMIT,
    code: "OTP_FALLBACK_SOURCE_RATE_LIMITED",
    message: "OTP fallback rate limit exceeded.",
  },
};

function retryAfterSeconds(milliseconds) {
  return Math.max(1, Math.ceil(milliseconds / 1_000));
}

function rateError(code, message, retryMilliseconds) {
  return new OtpError(code, 429, message, retryAfterSeconds(retryMilliseconds));
}

function activeWindow(startedAt, now, duration) {
  return startedAt instanceof Date && now.getTime() - startedAt.getTime() < duration;
}

function phoneDefaults(phone) {
  return {
    phone,
    lastSendAt: null,
    sendWindowStartedAt: null,
    sendCount: 0,
    verifyWindowStartedAt: null,
    verifyFailureCount: 0,
    verifyReservationIds: [],
    blockedUntil: null,
  };
}

function sourceDefaults(sourceHash) {
  return {
    sourceHash,
    challengeShortWindowStartedAt: null,
    challengeShortCount: 0,
    challengeHourStartedAt: null,
    challengeHourCount: 0,
    fallbackShortWindowStartedAt: null,
    fallbackShortCount: 0,
    fallbackHourStartedAt: null,
    fallbackHourCount: 0,
  };
}

function activityFields(now) {
  return {
    updatedAt: now,
    expiresAt: new Date(now.getTime() + OTP_STATE_RETENTION_MS),
  };
}

function evaluatePhoneStart(current, now, phone) {
  const state = current ?? phoneDefaults(phone);
  const retryIntervals = [];
  const cooldownActive =
    state.lastSendAt instanceof Date &&
    now.getTime() - state.lastSendAt.getTime() < OTP_PHONE_START_COOLDOWN_MS;
  if (cooldownActive) {
    retryIntervals.push(
      state.lastSendAt.getTime() + OTP_PHONE_START_COOLDOWN_MS - now.getTime(),
    );
  }

  const sendWindowActive = activeWindow(
    state.sendWindowStartedAt,
    now,
    OTP_PHONE_START_WINDOW_MS,
  );
  const sendCount = sendWindowActive ? state.sendCount : 0;
  const sendWindowStartedAt = sendWindowActive ? state.sendWindowStartedAt : now;
  if (sendCount >= OTP_PHONE_START_WINDOW_LIMIT) {
    retryIntervals.push(
      sendWindowStartedAt.getTime() + OTP_PHONE_START_WINDOW_MS - now.getTime(),
    );
  }
  if (retryIntervals.length > 0) {
    throw rateError(
      "OTP_RATE_LIMITED",
      "OTP request rate limit exceeded.",
      Math.max(...retryIntervals),
    );
  }

  return {
    next: {
      ...state,
      lastSendAt: now,
      sendWindowStartedAt,
      sendCount: sendCount + 1,
      ...activityFields(now),
    },
    publicResult: { retryAfterSeconds: OTP_PHONE_START_COOLDOWN_MS / 1_000 },
  };
}

function evaluateSourceAction(current, now, sourceHash, policy) {
  const state = current ?? sourceDefaults(sourceHash);
  const shortStartedKey = `${policy.prefix}ShortWindowStartedAt`;
  const shortCountKey = `${policy.prefix}ShortCount`;
  const hourStartedKey = `${policy.prefix}HourStartedAt`;
  const hourCountKey = `${policy.prefix}HourCount`;

  const shortActive = activeWindow(
    state[shortStartedKey],
    now,
    OTP_SOURCE_SHORT_WINDOW_MS,
  );
  const hourActive = activeWindow(
    state[hourStartedKey],
    now,
    OTP_SOURCE_HOUR_WINDOW_MS,
  );
  const shortStartedAt = shortActive ? state[shortStartedKey] : now;
  const hourStartedAt = hourActive ? state[hourStartedKey] : now;
  const shortCount = shortActive ? state[shortCountKey] : 0;
  const hourCount = hourActive ? state[hourCountKey] : 0;

  const retryIntervals = [];
  if (shortCount >= policy.shortLimit) {
    retryIntervals.push(
      shortStartedAt.getTime() + OTP_SOURCE_SHORT_WINDOW_MS - now.getTime(),
    );
  }
  if (hourCount >= policy.hourLimit) {
    retryIntervals.push(
      hourStartedAt.getTime() + OTP_SOURCE_HOUR_WINDOW_MS - now.getTime(),
    );
  }
  if (retryIntervals.length > 0) {
    throw rateError(policy.code, policy.message, Math.max(...retryIntervals));
  }

  return {
    next: {
      ...state,
      [shortStartedKey]: shortStartedAt,
      [shortCountKey]: shortCount + 1,
      [hourStartedKey]: hourStartedAt,
      [hourCountKey]: hourCount + 1,
      ...activityFields(now),
    },
    publicResult: undefined,
  };
}

function evaluateVerifyFailure(current, now, phone) {
  const state = current ?? phoneDefaults(phone);
  const windowActive = activeWindow(
    state.verifyWindowStartedAt,
    now,
    OTP_PHONE_VERIFY_WINDOW_MS,
  );
  const verifyWindowStartedAt = windowActive ? state.verifyWindowStartedAt : now;
  const verifyFailureCount = windowActive ? state.verifyFailureCount : 0;
  const verifyReservationIds =
    windowActive && Array.isArray(state.verifyReservationIds)
      ? state.verifyReservationIds
      : [];

  if (verifyFailureCount >= OTP_PHONE_VERIFY_FAILURE_LIMIT) {
    throw rateError(
      "OTP_VERIFY_RATE_LIMITED",
      "OTP verification rate limit exceeded.",
      verifyWindowStartedAt.getTime() + OTP_PHONE_VERIFY_WINDOW_MS - now.getTime(),
    );
  }

  const nextCount = verifyFailureCount + 1;
  const blockedUntil =
    nextCount >= OTP_PHONE_VERIFY_FAILURE_LIMIT
      ? new Date(verifyWindowStartedAt.getTime() + OTP_PHONE_VERIFY_WINDOW_MS)
      : null;

  return {
    next: {
      ...state,
      verifyWindowStartedAt,
      verifyFailureCount: nextCount,
      verifyReservationIds,
      blockedUntil,
      ...activityFields(now),
    },
    publicResult: { verifyFailureCount: nextCount, blockedUntil },
  };
}

function evaluateVerifyAttemptReservation(current, now, phone, reservationId) {
  const state = current ?? phoneDefaults(phone);
  const windowActive = activeWindow(
    state.verifyWindowStartedAt,
    now,
    OTP_PHONE_VERIFY_WINDOW_MS,
  );
  const verifyWindowStartedAt = windowActive ? state.verifyWindowStartedAt : now;
  const verifyFailureCount = windowActive ? state.verifyFailureCount : 0;
  const verifyReservationIds =
    windowActive && Array.isArray(state.verifyReservationIds)
      ? state.verifyReservationIds.filter((value) => typeof value === "string")
      : [];

  if (verifyReservationIds.includes(reservationId)) {
    return {
      skip: true,
      publicResult: {
        verifyFailureCount,
        blockedUntil: state.blockedUntil ?? null,
      },
    };
  }

  if (verifyFailureCount >= OTP_PHONE_VERIFY_FAILURE_LIMIT) {
    throw rateError(
      "OTP_VERIFY_RATE_LIMITED",
      "OTP verification rate limit exceeded.",
      verifyWindowStartedAt.getTime() + OTP_PHONE_VERIFY_WINDOW_MS - now.getTime(),
    );
  }

  const nextCount = verifyFailureCount + 1;
  const blockedUntil =
    nextCount >= OTP_PHONE_VERIFY_FAILURE_LIMIT
      ? new Date(verifyWindowStartedAt.getTime() + OTP_PHONE_VERIFY_WINDOW_MS)
      : null;

  return {
    next: {
      ...state,
      verifyWindowStartedAt,
      verifyFailureCount: nextCount,
      verifyReservationIds: [...verifyReservationIds, reservationId],
      blockedUntil,
      ...activityFields(now),
    },
    publicResult: { verifyFailureCount: nextCount, blockedUntil },
  };
}

function evaluateReleaseVerifyAttempt(current, now, reservationId) {
  if (
    !current ||
    !activeWindow(current.verifyWindowStartedAt, now, OTP_PHONE_VERIFY_WINDOW_MS) ||
    !Array.isArray(current.verifyReservationIds) ||
    !current.verifyReservationIds.includes(reservationId)
  ) {
    return { skip: true, publicResult: { released: false } };
  }

  const verifyFailureCount = Math.max(0, current.verifyFailureCount - 1);
  return {
    next: {
      ...current,
      verifyWindowStartedAt:
        verifyFailureCount === 0 ? null : current.verifyWindowStartedAt,
      verifyFailureCount,
      verifyReservationIds: current.verifyReservationIds.filter(
        (value) => value !== reservationId,
      ),
      blockedUntil: null,
      ...activityFields(now),
    },
    publicResult: { released: true },
  };
}

function evaluateClearVerifyFailures(current, now) {
  if (!current) return { skip: true, publicResult: undefined };

  return {
    next: {
      ...current,
      verifyWindowStartedAt: null,
      verifyFailureCount: 0,
      verifyReservationIds: [],
      blockedUntil: null,
      ...activityFields(now),
    },
    publicResult: undefined,
  };
}

async function mutateWithCas(collection, key, now, evaluate) {
  for (let attempt = 0; attempt < OTP_STATE_CAS_MAX_ATTEMPTS; attempt += 1) {
    const current = await collection.findOne(key);
    const decision = evaluate(current, now);
    if (decision.skip) return decision.publicResult;

    if (!current) {
      try {
        await collection.insertOne({ ...key, ...decision.next, version: 1 });
        return decision.publicResult;
      } catch (error) {
        if (error?.code === 11000) continue;
        throw error;
      }
    }

    const next = { ...decision.next };
    delete next._id;
    delete next.version;
    const result = await collection.updateOne(
      { _id: current._id, version: current.version },
      { $set: next, $inc: { version: 1 } },
    );
    if (result.modifiedCount === 1) return decision.publicResult;
  }

  throw new OtpError("OTP_STATE_BUSY", 503, "OTP security state is busy.");
}

export function createOtpRateLimitStore({
  phoneCollection,
  sourceCollection,
  clock = { now: () => new Date() },
}) {
  const indexesReady = Promise.all([
    phoneCollection.createIndex(
      { phone: 1 },
      { unique: true, name: "otp_security_phone" },
    ),
    phoneCollection.createIndex(
      { expiresAt: 1 },
      { expireAfterSeconds: 0, name: "otp_security_expires_ttl" },
    ),
    sourceCollection.createIndex(
      { sourceHash: 1 },
      { unique: true, name: "otp_source_security_source_hash" },
    ),
    sourceCollection.createIndex(
      { expiresAt: 1 },
      { expireAfterSeconds: 0, name: "otp_source_security_expires_ttl" },
    ),
  ]);

  async function withIndexes(operation) {
    await indexesReady;
    return operation(new Date(clock.now()));
  }

  return {
    claimPhoneStart(phone) {
      return withIndexes((now) =>
        mutateWithCas(phoneCollection, { phone }, now, (current) =>
          evaluatePhoneStart(current, now, phone),
        ),
      );
    },

    claimSourceAction(sourceHash, action) {
      const policy = SOURCE_POLICIES[action];
      if (!policy) throw new TypeError("Unknown OTP source action.");

      return withIndexes((now) =>
        mutateWithCas(sourceCollection, { sourceHash }, now, (current) =>
          evaluateSourceAction(current, now, sourceHash, policy),
        ),
      );
    },

    async getPhoneVerifyLimit(phone) {
      await indexesReady;
      const now = new Date(clock.now());
      const current = await phoneCollection.findOne({ phone });
      if (
        !current ||
        !activeWindow(current.verifyWindowStartedAt, now, OTP_PHONE_VERIFY_WINDOW_MS)
      ) {
        return { remainingFailures: OTP_PHONE_VERIFY_FAILURE_LIMIT };
      }

      const remainingFailures = Math.max(
        0,
        OTP_PHONE_VERIFY_FAILURE_LIMIT - current.verifyFailureCount,
      );
      if (remainingFailures === 0) {
        throw rateError(
          "OTP_VERIFY_RATE_LIMITED",
          "OTP verification rate limit exceeded.",
          current.verifyWindowStartedAt.getTime() +
            OTP_PHONE_VERIFY_WINDOW_MS -
            now.getTime(),
        );
      }

      return { remainingFailures };
    },

    reservePhoneVerifyAttempt(phone, reservationId) {
      if (typeof reservationId !== "string" || !reservationId) {
        throw new TypeError("OTP verification reservation ID is required.");
      }

      return withIndexes((now) =>
        mutateWithCas(phoneCollection, { phone }, now, (current) =>
          evaluateVerifyAttemptReservation(
            current,
            now,
            phone,
            reservationId,
          ),
        ),
      );
    },

    releasePhoneVerifyAttempt(phone, reservationId) {
      if (typeof reservationId !== "string" || !reservationId) {
        throw new TypeError("OTP verification reservation ID is required.");
      }

      return withIndexes((now) =>
        mutateWithCas(phoneCollection, { phone }, now, (current) =>
          evaluateReleaseVerifyAttempt(current, now, reservationId),
        ),
      );
    },

    recordPhoneVerifyFailure(phone) {
      return withIndexes((now) =>
        mutateWithCas(phoneCollection, { phone }, now, (current) =>
          evaluateVerifyFailure(current, now, phone),
        ),
      );
    },

    clearPhoneVerifyFailures(phone) {
      return withIndexes((now) =>
        mutateWithCas(phoneCollection, { phone }, now, (current) =>
          evaluateClearVerifyFailures(current, now),
        ),
      );
    },
  };
}
