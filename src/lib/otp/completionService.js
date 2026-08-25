import { randomUUID } from "node:crypto";
import { issueBookingGrant as issueBookingGrantContract } from "./bookingGrant";
import {
  getCustomerSessionTtlSeconds,
  signCustomerSession as signCustomerSessionContract,
} from "@/lib/customerSession";
import {
  OTP_GRANT_TTL_MS,
  OTP_PHONE_VERIFY_FAILURE_LIMIT,
} from "./constants";
import { hashBearerToken, safeCompareDevelopmentCode } from "./crypto";
import { OtpError } from "./errors";
import { verifyFirebaseEvidence as verifyFirebaseEvidenceContract } from "./firebaseEvidence";
import { createOtpRateLimitStore } from "./rateLimitStore";
import {
  classifyTwilioVerifyError as classifyTwilioVerifyErrorContract,
  verifyTwilioCode as verifyTwilioCodeContract,
} from "@/lib/twilioOTP";

const SUPPORTED_PROVIDERS = new Set(["firebase", "twilio", "development"]);
const ELIGIBLE_STATUSES = {
  firebase: "pending",
  twilio: "twilio_sent",
  development: "pending",
};
const ERROR_DETAILS = {
  OTP_CHALLENGE_TOKEN_REQUIRED: [400, "OTP challenge token is required."],
  OTP_PROVIDER_REQUIRED: [400, "OTP provider is required."],
  OTP_PROVIDER_MISMATCH: [400, "OTP provider mismatch."],
  OTP_EVIDENCE_REQUIRED: [400, "OTP evidence is required."],
  OTP_VERIFICATION_INVALID: [401, "OTP verification is invalid."],
  OTP_VERIFICATION_EXPIRED: [401, "OTP verification has expired."],
  OTP_CHALLENGE_ALREADY_COMPLETED: [
    409,
    "OTP challenge is already completed.",
  ],
  OTP_COMPLETION_IN_PROGRESS: [409, "OTP completion is in progress."],
  INVALID_OTP: [401, "Invalid verification code."],
  OTP_VERIFY_RATE_LIMITED: [429, "OTP verification rate limit exceeded."],
  OTP_VERIFY_TEMPORARY_FAILURE: [
    503,
    "OTP verification is temporarily unavailable.",
  ],
  OTP_VERIFY_FAILED: [503, "OTP verification failed."],
  OTP_SERVICE_NOT_CONFIGURED: [503, "OTP verification is unavailable."],
  OTP_DEVELOPMENT_COMPLETION_UNAVAILABLE: [
    503,
    "Development OTP completion is unavailable.",
  ],
  OTP_COMPLETION_FAILED: [500, "OTP completion failed."],
};
const systemClock = { now: () => new Date() };
let productionRateLimitStorePromise;

function completionError(code) {
  const [status, message] =
    ERROR_DETAILS[code] ?? ERROR_DETAILS.OTP_COMPLETION_FAILED;
  return new OtpError(code, status, message);
}

function validDate(value) {
  return value instanceof Date && Number.isFinite(value.getTime());
}

function requiredEvidence(value) {
  if (typeof value !== "string" || !value.trim()) {
    throw completionError("OTP_EVIDENCE_REQUIRED");
  }
  return value;
}

function validateStoredChallenge({
  challenge,
  challengeTokenHash,
  payloadProvider,
  now,
}) {
  if (
    !challenge?._id ||
    challenge.challengeTokenHash !== challengeTokenHash ||
    typeof challenge.phone !== "string" ||
    !challenge.phone ||
    challenge.phone.trim() !== challenge.phone ||
    !validDate(challenge.createdAt) ||
    !validDate(challenge.expiresAt) ||
    !SUPPORTED_PROVIDERS.has(challenge.provider) ||
    (challenge.purpose !== "booking" && challenge.purpose !== "login")
  ) {
    throw completionError("OTP_VERIFICATION_INVALID");
  }

  if (challenge.status === "completed") {
    throw completionError("OTP_CHALLENGE_ALREADY_COMPLETED");
  }
  if (challenge.status === "completing") {
    throw completionError("OTP_COMPLETION_IN_PROGRESS");
  }
  if (challenge.expiresAt <= now) {
    throw completionError("OTP_VERIFICATION_EXPIRED");
  }
  if (payloadProvider !== challenge.provider) {
    throw completionError("OTP_PROVIDER_MISMATCH");
  }
  if (challenge.status !== ELIGIBLE_STATUSES[challenge.provider]) {
    throw completionError("OTP_VERIFICATION_INVALID");
  }
}

async function getProductionRateLimitStore() {
  if (!productionRateLimitStorePromise) {
    productionRateLimitStorePromise = import("@/lib/db").then(
      ({ getCollection }) =>
        Promise.all([
          getCollection("otpSecurityState"),
          getCollection("otpSourceSecurityState"),
        ]).then(([phoneCollection, sourceCollection]) =>
          createOtpRateLimitStore({ phoneCollection, sourceCollection }),
        ),
    );
  }
  return productionRateLimitStorePromise;
}

async function getRateLimitStore(deps) {
  return deps.rateLimitStore ?? deps.rateStore ?? getProductionRateLimitStore();
}

async function verifyFirebase({ idToken, challenge, now }, deps) {
  if (deps.verifyFirebaseEvidence) {
    return deps.verifyFirebaseEvidence({ idToken, challenge, now });
  }

  const { firebaseAdminAuth } = await import("@/lib/firebaseAdmin");
  return verifyFirebaseEvidenceContract(
    { idToken, challenge, now },
    { adminAuth: firebaseAdminAuth },
  );
}

async function recordInvalidCode(rateLimitStore, phone) {
  const state = await rateLimitStore.recordPhoneVerifyFailure(phone);
  if (state?.verifyFailureCount >= OTP_PHONE_VERIFY_FAILURE_LIMIT) {
    throw completionError("OTP_VERIFY_RATE_LIMITED");
  }
  throw completionError("INVALID_OTP");
}

function rejectReservedInvalidCode(reservation) {
  if (reservation?.verifyFailureCount >= OTP_PHONE_VERIFY_FAILURE_LIMIT) {
    throw completionError("OTP_VERIFY_RATE_LIMITED");
  }
  throw completionError("INVALID_OTP");
}

function twilioFailure(classification) {
  switch (classification?.errorCode) {
    case "OTP_VERIFY_RATE_LIMITED":
      return completionError("OTP_VERIFY_RATE_LIMITED");
    case "OTP_VERIFY_TEMPORARY_FAILURE":
      return completionError("OTP_VERIFY_TEMPORARY_FAILURE");
    case "OTP_SERVICE_NOT_CONFIGURED":
      return completionError("OTP_SERVICE_NOT_CONFIGURED");
    default:
      return completionError("OTP_VERIFY_FAILED");
  }
}

async function verifyStoredPhoneWithTwilio({ challenge, code }, deps) {
  const rateLimitStore = await getRateLimitStore(deps);
  const verifyAttemptIdFactory = deps.verifyAttemptIdFactory ?? randomUUID;
  const reservationId = verifyAttemptIdFactory();
  const reservation = await rateLimitStore.reservePhoneVerifyAttempt(
    challenge.phone,
    reservationId,
  );

  const verifyTwilioCode = deps.verifyTwilioCode ?? verifyTwilioCodeContract;
  const classifyTwilioVerifyError =
    deps.classifyTwilioVerifyError ?? classifyTwilioVerifyErrorContract;

  let result;
  try {
    result = await verifyTwilioCode(challenge.phone, code);
  } catch (error) {
    const classification = classifyTwilioVerifyError(error);
    if (classification?.errorCode === "INVALID_OTP") {
      return rejectReservedInvalidCode(reservation);
    }
    throw twilioFailure(classification);
  }

  if (result?.status !== "approved") {
    return rejectReservedInvalidCode(reservation);
  }

  return { rateLimitStore, phone: challenge.phone };
}

async function clearVerifiedPhoneLimit(verificationAdmission) {
  if (!verificationAdmission) return;
  try {
    await verificationAdmission.rateLimitStore.clearPhoneVerifyFailures(
      verificationAdmission.phone,
    );
  } catch {
    // Completion is authoritative; retaining the bound is fail-closed.
  }
}

async function verifyDevelopmentChallenge({ challenge, code }, deps) {
  const env = deps.env ?? process.env;
  const configuredCode = env.OTP_DEV_CODE;
  if (
    env.NODE_ENV === "production" ||
    typeof configuredCode !== "string" ||
    !configuredCode.trim()
  ) {
    throw completionError("OTP_DEVELOPMENT_COMPLETION_UNAVAILABLE");
  }

  const submittedCode = requiredEvidence(code);
  const rateLimitStore = await getRateLimitStore(deps);
  await rateLimitStore.getPhoneVerifyLimit(challenge.phone);
  if (!safeCompareDevelopmentCode(submittedCode, configuredCode)) {
    return recordInvalidCode(rateLimitStore, challenge.phone);
  }

  await rateLimitStore.clearPhoneVerifyFailures(challenge.phone);
}

async function getUsersDataCollection(deps) {
  if (deps.usersData) return deps.usersData;
  const { getCollection } = await import("@/lib/db");
  return getCollection("usersData");
}

async function readMinimizedProfile(challenge, deps) {
  const usersData = await getUsersDataCollection(deps);
  const document = await usersData.findOne(
    { phone: challenge.phone },
    { projection: { firstName: 1, lastName: 1 } },
  );
  const firstName =
    typeof document?.firstName === "string" ? document.firstName.trim() : "";
  const lastName =
    typeof document?.lastName === "string" ? document.lastName.trim() : "";

  if (!firstName || !lastName) return { hasCompleteName: false };
  return { hasCompleteName: true, firstName, lastName };
}

async function completeLoginChallenge(
  { challenge, challengeTokenHash, challengeStore, clock },
  deps,
) {
  const sessionTtlSeconds = getCustomerSessionTtlSeconds({ env: deps.env });
  const signCustomerSession =
    deps.signCustomerSession ?? signCustomerSessionContract;
  const signingNow = new Date(clock.now());
  const sessionToken = await signCustomerSession(challenge.phone, {
    env: deps.env,
    now: signingNow,
    ttlSeconds: sessionTtlSeconds,
  });
  if (typeof sessionToken !== "string" || !sessionToken) {
    throw completionError("OTP_COMPLETION_FAILED");
  }

  const completionNow = new Date(clock.now());
  const completed = await challengeStore.completeLogin({
    challengeId: challenge._id,
    challengeTokenHash,
    purpose: "login",
    provider: challenge.provider,
    eligibleStatus: ELIGIBLE_STATUSES[challenge.provider],
    now: completionNow,
  });
  if (!completed) {
    throw completionError("OTP_CHALLENGE_ALREADY_COMPLETED");
  }

  return { purpose: "login", sessionToken, sessionTtlSeconds };
}

export async function completeOtpChallenge(payload, deps = {}) {
  if (typeof payload?.challengeToken !== "string" || !payload.challengeToken.trim()) {
    throw completionError("OTP_CHALLENGE_TOKEN_REQUIRED");
  }
  if (typeof payload.provider !== "string" || !payload.provider.trim()) {
    throw completionError("OTP_PROVIDER_REQUIRED");
  }

  const hashChallengeToken = deps.hashChallengeToken ?? hashBearerToken;
  const challengeTokenHash = hashChallengeToken(payload.challengeToken);
  const challengeStore =
    deps.challengeStore ??
    (await (await import("./challengeStore")).getOtpChallengeStore());
  const challenge = await challengeStore.findByTokenHash(challengeTokenHash);
  const clock = deps.clock ?? systemClock;
  const now = new Date(clock.now());

  validateStoredChallenge({
    challenge,
    challengeTokenHash,
    payloadProvider: payload.provider,
    now,
  });

  let verificationAdmission;
  switch (challenge.provider) {
    case "firebase":
      await verifyFirebase(
        {
          idToken: requiredEvidence(payload.idToken),
          challenge,
          now,
        },
        deps,
      );
      break;
    case "twilio":
      verificationAdmission = await verifyStoredPhoneWithTwilio(
        { challenge, code: requiredEvidence(payload.code) },
        deps,
      );
      break;
    case "development":
      await verifyDevelopmentChallenge(
        { challenge, code: payload.code },
        deps,
      );
      break;
    default:
      throw completionError("OTP_PROVIDER_MISMATCH");
  }

  if (challenge.purpose === "login") {
    const result = await completeLoginChallenge(
      { challenge, challengeTokenHash, challengeStore, clock },
      deps,
    );
    await clearVerifiedPhoneLimit(verificationAdmission);
    return result;
  }

  const profile = await readMinimizedProfile(challenge, deps);
  const issueBookingGrant = deps.issueBookingGrant ?? issueBookingGrantContract;
  const grant = await issueBookingGrant({ challenge, challengeTokenHash });
  if (
    typeof grant?.verificationToken !== "string" ||
    !grant.verificationToken
  ) {
    throw completionError("OTP_COMPLETION_FAILED");
  }
  await clearVerifiedPhoneLimit(verificationAdmission);

  return {
    success: true,
    purpose: "booking",
    verificationToken: grant.verificationToken,
    expiresInSeconds: OTP_GRANT_TTL_MS / 1_000,
    profile,
  };
}
