import { randomInt } from "node:crypto";
import {
  OTP_GLOBAL_SEND_DAY_WINDOW_MS,
  OTP_GLOBAL_SEND_HOUR_WINDOW_MS,
  OTP_GLOBAL_SEND_LIMIT_CONFIG,
  OTP_GLOBAL_SEND_RETENTION_MS,
  OTP_PHONE_START_COOLDOWN_MS,
  OTP_PHONE_START_WINDOW_LIMIT,
  OTP_PHONE_START_WINDOW_MS,
  OTP_PHONE_VERIFY_FAILURE_LIMIT,
  OTP_PHONE_VERIFY_WINDOW_MS,
  OTP_SOURCE_CHALLENGE_HOUR_LIMIT,
  OTP_SOURCE_CHALLENGE_SHORT_LIMIT,
  OTP_SOURCE_SEND_HOUR_LIMIT,
  OTP_SOURCE_SEND_SHORT_LIMIT,
  OTP_SOURCE_HOUR_WINDOW_MS,
  OTP_SOURCE_SHORT_WINDOW_MS,
  OTP_SOURCE_LIMIT_CONFIG,
  OTP_STATE_CAS_MAX_ATTEMPTS,
  OTP_STATE_RETENTION_MS,
} from "./constants";
import { OtpError, otpRetryMetadata } from "./errors";
import { logOtpEvent } from "./diagnostics";

// Not a source-identity hash; all application instances share this budget row.
const GLOBAL_SEND_SOURCE_HASH = "otp:global-send";
const DURABLE_READ_OPTIONS = { readPreference: "primary", readConcern: { level: "majority" } };
const DURABLE_WRITE_OPTIONS = { writeConcern: { w: "majority" } };

const SOURCE_POLICIES = {
  challenge: {
    prefix: "challenge",
    shortLimit: OTP_SOURCE_CHALLENGE_SHORT_LIMIT,
    hourLimit: OTP_SOURCE_CHALLENGE_HOUR_LIMIT,
    code: "OTP_SOURCE_RATE_LIMITED",
    message: "OTP challenge rate limit exceeded.",
  },
  send: {
    prefix: "send",
    shortLimit: OTP_SOURCE_SEND_SHORT_LIMIT,
    hourLimit: OTP_SOURCE_SEND_HOUR_LIMIT,
    code: "OTP_SEND_SOURCE_RATE_LIMITED",
    message: "OTP send rate limit exceeded.",
  },
};

function rateError(code, message, retryMilliseconds, now, scope = "phone") {
  const metadata = otpRetryMetadata(new Date(now.getTime() + retryMilliseconds), now, scope);
  return new OtpError(code, 429, message, metadata.retryAfterSeconds, metadata);
}

function configuredLimits(env, configuration) {
  const limits = {};
  for (const [key, { defaultValue, max }] of Object.entries(configuration)) {
    const raw = env?.[key];
    const value = typeof raw === "string" && /^[1-9]\d*$/.test(raw) ? Number(raw) : raw;
    const valid = Number.isSafeInteger(value) && value >= 1 && value <= max;
    limits[key] = valid ? value : defaultValue;
    if (raw !== undefined && !valid) {
      logOtpEvent({ stage: "configuration", decision: "reject", errorCode: "OTP_RATE_LIMIT_CONFIG_INVALID" });
    }
  }
  return limits;
}

function sourcePolicies(env) {
  const limits = configuredLimits(env, OTP_SOURCE_LIMIT_CONFIG);
  return {
    challenge: { ...SOURCE_POLICIES.challenge, shortLimit: limits.OTP_SOURCE_CHALLENGE_SHORT_LIMIT, hourLimit: limits.OTP_SOURCE_CHALLENGE_HOUR_LIMIT },
    send: { ...SOURCE_POLICIES.send, shortLimit: limits.OTP_SOURCE_SEND_SHORT_LIMIT, hourLimit: limits.OTP_SOURCE_SEND_HOUR_LIMIT },
  };
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
    sendShortWindowStartedAt: null,
    sendShortCount: 0,
    sendHourStartedAt: null,
    sendHourCount: 0,
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
      now,
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
    publicResult: otpRetryMetadata(new Date(Math.max(
      now.getTime() + OTP_PHONE_START_COOLDOWN_MS,
      sendCount + 1 >= OTP_PHONE_START_WINDOW_LIMIT
        ? sendWindowStartedAt.getTime() + OTP_PHONE_START_WINDOW_MS
        : 0,
    )), now),
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
    throw rateError(policy.code, policy.message, Math.max(...retryIntervals), now, "source");
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

function evaluateGlobalSend(current, now, limits) {
  const state = current ?? {};
  const hourActive = activeWindow(state.globalHourStartedAt, now, OTP_GLOBAL_SEND_HOUR_WINDOW_MS);
  const dayActive = activeWindow(state.globalDayStartedAt, now, OTP_GLOBAL_SEND_DAY_WINDOW_MS);
  const globalHourStartedAt = hourActive ? state.globalHourStartedAt : now;
  const globalDayStartedAt = dayActive ? state.globalDayStartedAt : now;
  const globalHourCount = hourActive ? state.globalHourCount : 0;
  const globalDayCount = dayActive ? state.globalDayCount : 0;
  const retryIntervals = [];

  if (globalHourCount >= limits.OTP_GLOBAL_SEND_HOUR_LIMIT) {
    retryIntervals.push(globalHourStartedAt.getTime() + OTP_GLOBAL_SEND_HOUR_WINDOW_MS - now.getTime());
  }
  if (globalDayCount >= limits.OTP_GLOBAL_SEND_DAY_LIMIT) {
    retryIntervals.push(globalDayStartedAt.getTime() + OTP_GLOBAL_SEND_DAY_WINDOW_MS - now.getTime());
  }
  if (retryIntervals.length > 0) {
    throw rateError(
      "OTP_SEND_BUDGET_EXCEEDED",
      "OTP send budget exceeded.",
      Math.max(...retryIntervals),
      now,
      "global",
    );
  }

  return {
    next: {
      ...state,
      globalHourStartedAt,
      globalHourCount: globalHourCount + 1,
      globalDayStartedAt,
      globalDayCount: globalDayCount + 1,
      updatedAt: now,
      expiresAt: new Date(now.getTime() + OTP_GLOBAL_SEND_RETENTION_MS),
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
      now,
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
      now,
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
    // Competing requests otherwise retry in lockstep on the shared source row.
    // Jitter changes only contention timing, never budgets or the eight-attempt cap.
    if (attempt > 0) await new Promise((resolve) => setTimeout(resolve, randomInt(8, Math.min(160, 16 * 2 ** attempt))));
    const current = await collection.findOne(key, DURABLE_READ_OPTIONS);
    const decision = evaluate(current, now);
    if (decision.skip) return decision.publicResult;

    if (!current) {
      try {
        await collection.insertOne({ ...key, ...decision.next, version: 1 }, DURABLE_WRITE_OPTIONS);
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
      DURABLE_WRITE_OPTIONS,
    );
    if (result.modifiedCount === 1) return decision.publicResult;
  }

  throw new OtpError("OTP_STATE_BUSY", 503, "OTP security state is busy.");
}

export function createOtpRateLimitStore({
  phoneCollection,
  sourceCollection,
  clock = { now: () => new Date() },
  env = process.env,
}) {
  const policies = sourcePolicies(env);
  const globalLimits = configuredLimits(env, OTP_GLOBAL_SEND_LIMIT_CONFIG);
  let indexesReady;

  function ensureIndexes() {
    if (!indexesReady) {
      indexesReady = Promise.all([
        phoneCollection.createIndex(
          { phone: 1 },
          { unique: true, name: "otp_security_phone", ...DURABLE_WRITE_OPTIONS },
        ),
        phoneCollection.createIndex(
          { expiresAt: 1 },
          { expireAfterSeconds: 0, name: "otp_security_expires_ttl", ...DURABLE_WRITE_OPTIONS },
        ),
        sourceCollection.createIndex(
          { sourceHash: 1 },
          { unique: true, name: "otp_source_security_source_hash", ...DURABLE_WRITE_OPTIONS },
        ),
        sourceCollection.createIndex(
          { expiresAt: 1 },
          { expireAfterSeconds: 0, name: "otp_source_security_expires_ttl", ...DURABLE_WRITE_OPTIONS },
        ),
      ]).catch((error) => {
        indexesReady = undefined;
        throw error;
      });
    }
    return indexesReady;
  }

  async function withIndexes(operation) {
    await ensureIndexes();
    return operation(new Date(clock.now()));
  }

  return {
    ensureIndexes,

    claimPhoneStart(phone) {
      return withIndexes((now) =>
        mutateWithCas(phoneCollection, { phone }, now, (current) =>
          evaluatePhoneStart(current, now, phone),
        ),
      );
    },

    claimSourceAction(sourceHash, action) {
      if (!Object.hasOwn(policies, action)) throw new TypeError("Unknown OTP source action.");
      if (sourceHash === GLOBAL_SEND_SOURCE_HASH) throw new TypeError("Reserved OTP source key.");
      const policy = policies[action];

      return withIndexes((now) =>
        mutateWithCas(sourceCollection, { sourceHash }, now, (current) =>
          evaluateSourceAction(current, now, sourceHash, policy),
        ),
      );
    },

    claimGlobalSend() {
      return withIndexes((now) =>
        mutateWithCas(sourceCollection, { sourceHash: GLOBAL_SEND_SOURCE_HASH }, now, (current) =>
          evaluateGlobalSend(current, now, globalLimits),
        ),
      );
    },

    async getPhoneVerifyLimit(phone) {
      await ensureIndexes();
      const now = new Date(clock.now());
      const current = await phoneCollection.findOne({ phone }, DURABLE_READ_OPTIONS);
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
          now,
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
