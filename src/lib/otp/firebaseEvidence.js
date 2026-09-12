import "server-only";
import { normalizeIsraeliPhone } from "@/lib/phone";
import { OTP_CHALLENGE_TTL_MS } from "./constants";
import { OtpError } from "./errors";
import { getFirebaseAdminAuth, getFirebaseProjectId } from "./firebaseAdminAuth";
import { logFirebaseAdminEvent } from "./diagnostics";

const MAX_TOKEN_LENGTH = 16_384;
const MAX_CLOCK_SKEW_SECONDS = 30;
const MAX_AUTH_AGE_SECONDS = OTP_CHALLENGE_TTL_MS / 1000;
const MAX_TIMESTAMP_SECONDS = 8_640_000_000_000;
const INVALID_TOKEN_CODES = new Set([
  "auth/invalid-id-token", "auth/id-token-revoked", "auth/user-disabled", "auth/user-not-found",
  "auth/tenant-id-mismatch",
]);
const CONFIGURATION_CODES = new Set([
  "OTP_SERVICE_NOT_CONFIGURED", "auth/invalid-credential", "auth/insufficient-permission",
  "auth/project-not-found", "auth/invalid-config", "app/invalid-credential", "app/invalid-app-options",
]);
const NETWORK_CODES = new Set([
  "app/network-error", "app/network-timeout", "ENOTFOUND", "EAI_AGAIN", "ECONNRESET",
  "ECONNREFUSED", "ETIMEDOUT", "ECONNABORTED", "EHOSTUNREACH", "ENETUNREACH", "EPIPE",
  "UND_ERR_CONNECT_TIMEOUT", "UND_ERR_HEADERS_TIMEOUT", "UND_ERR_SOCKET",
]);
const TOKEN_REJECTION_PREFIXES = [
  "Decoding Firebase ID token failed.",
  "verifyIdToken() expects an ID token, but was given a custom token.",
  "verifyIdToken() expects an ID token, but was given a legacy custom token.",
  "Firebase ID token has invalid signature.",
  'Firebase ID token has no "kid" claim.',
  "Firebase ID token has incorrect algorithm.",
  'Firebase ID token has incorrect "aud" (audience) claim.',
  'Firebase ID token has incorrect "iss" (issuer) claim.',
  'Firebase ID token has no "sub" (subject) claim.',
  'Firebase ID token has an empty "sub" (subject) claim.',
  'Firebase ID token has a "sub" (subject) claim longer than 128 characters.',
  'Firebase ID token has "kid" claim which does not correspond to a known public key.',
];

function invalidEvidence() {
  return new OtpError("OTP_VERIFICATION_INVALID", 401, "Phone verification evidence is invalid.");
}

function expiredEvidence() {
  return new OtpError("OTP_VERIFICATION_EXPIRED", 401, "Phone verification evidence has expired.");
}

function infrastructureFailure(error) {
  const pending = [error];
  const seen = new Set();
  for (let index = 0; index < pending.length && index < 12; index += 1) {
    const item = pending[index];
    if (!item || typeof item !== "object" || seen.has(item)) continue;
    seen.add(item);
    const status = item.status ?? item.statusCode;
    if (NETWORK_CODES.has(item.code) || status === 408 || status === 429 || (status >= 500 && status <= 599)) return true;
    pending.push(item.cause, item.response);
  }
  return false;
}

function verificationError(error) {
  if (!(error instanceof OtpError) && infrastructureFailure(error)) {
    return new OtpError("OTP_VERIFY_TEMPORARY_FAILURE", 503, "Phone verification is temporarily unavailable.");
  }
  if (error?.code === "auth/id-token-expired") return expiredEvidence();
  if (CONFIGURATION_CODES.has(error?.code)) {
    return new OtpError("OTP_SERVICE_NOT_CONFIGURED", 503, "Phone verification is not configured.");
  }
  if (INVALID_TOKEN_CODES.has(error?.code)) return invalidEvidence();

  // Admin also wraps certificate/network failures as argument-error. Only its
  // definitive token-rejection messages are invalid evidence; unknowns remain 503.
  if (error?.code === "auth/argument-error" || error?.code === "auth/invalid-argument") {
    const message = typeof error.message === "string" ? error.message.slice(0, 512) : "";
    if (TOKEN_REJECTION_PREFIXES.some((prefix) => message.startsWith(prefix))) {
      return invalidEvidence();
    }
  }
  return new OtpError("OTP_VERIFY_TEMPORARY_FAILURE", 503, "Phone verification is temporarily unavailable.");
}

const validDate = (value) => value instanceof Date && Number.isFinite(+value);
const validTimestamp = (value) => Number.isSafeInteger(value) && value >= 0 && value <= MAX_TIMESTAMP_SECONDS;

export async function verifyFirebaseEvidence(idToken, challenge, { env = process.env, now = new Date(), verifyIdToken } = {}) {
  const projectId = getFirebaseProjectId(env);
  const nowMs = now instanceof Date ? +now : now;
  if (typeof nowMs !== "number" || !Number.isFinite(nowMs) || nowMs < 0 || nowMs > MAX_TIMESTAMP_SECONDS * 1000 ||
      typeof idToken !== "string" || !idToken.trim() || idToken.length > MAX_TOKEN_LENGTH ||
      typeof challenge?.phone !== "string" || !challenge.phone || normalizeIsraeliPhone(challenge.phone) !== challenge.phone ||
      !validDate(challenge.createdAt) || !validDate(challenge.expiresAt) ||
      +challenge.createdAt < 0 || +challenge.createdAt > nowMs || challenge.expiresAt <= challenge.createdAt) {
    throw invalidEvidence();
  }
  if (+challenge.expiresAt <= nowMs) throw expiredEvidence();

  let decoded;
  const diagnostic = (decision, error) => logFirebaseAdminEvent({ correlationId: challenge.correlationId, stage: "firebase_admin_verify", decision, error });
  try {
    diagnostic("started");
    if (verifyIdToken !== undefined) {
      decoded = await verifyIdToken(idToken, true);
    } else {
      const auth = await getFirebaseAdminAuth({ env, correlationId: challenge.correlationId });
      // Revocation checking includes a user lookup; lookup outages must remain retryable.
      decoded = await auth.verifyIdToken(idToken, true);
    }
  } catch (error) {
    diagnostic("failed", error);
    throw verificationError(error);
  }
  diagnostic("success");

  if (!decoded || typeof decoded !== "object" || Array.isArray(decoded) ||
      typeof decoded.uid !== "string" || !decoded.uid || decoded.uid.length > 128 || decoded.sub !== decoded.uid ||
      decoded.aud !== projectId || decoded.iss !== `https://securetoken.google.com/${projectId}` ||
      decoded.phone_number !== challenge.phone || decoded.firebase?.sign_in_provider !== "phone" ||
      !validTimestamp(decoded.auth_time) || !validTimestamp(decoded.iat) || !validTimestamp(decoded.exp)) {
    throw invalidEvidence();
  }

  const nowSeconds = Math.floor(nowMs / 1000);
  // Refreshing a cached session changes iat, not auth_time. Never allow a previous
  // authentication second to satisfy a new challenge, even within clock skew.
  if (decoded.auth_time < Math.floor(+challenge.createdAt / 1000) ||
      decoded.auth_time > nowSeconds + MAX_CLOCK_SKEW_SECONDS ||
      decoded.iat > nowSeconds + MAX_CLOCK_SKEW_SECONDS ||
      decoded.auth_time > decoded.iat || decoded.exp <= decoded.iat) {
    throw invalidEvidence();
  }
  if (decoded.exp <= nowSeconds || nowSeconds - decoded.auth_time > MAX_AUTH_AGE_SECONDS) {
    throw expiredEvidence();
  }

  return { uid: decoded.uid, authTime: decoded.auth_time };
}
