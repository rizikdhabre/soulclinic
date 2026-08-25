import { normalizeIsraeliPhone } from "@/lib/phone";
import { FIREBASE_CLOCK_SKEW_MS } from "./constants";
import { OtpError } from "./errors";

function invalidFirebaseToken() {
  return new OtpError(
    "INVALID_FIREBASE_TOKEN",
    401,
    "Invalid Firebase phone verification.",
  );
}

function dateMilliseconds(value) {
  if (!(value instanceof Date)) return null;

  const milliseconds = value.getTime();
  return Number.isFinite(milliseconds) ? milliseconds : null;
}

function normalizedPhone(value) {
  return typeof value === "string" ? normalizeIsraeliPhone(value) : null;
}

function activeFirebaseChallenge(challenge, now) {
  const nowMilliseconds = dateMilliseconds(now);
  const createdAtMilliseconds = dateMilliseconds(challenge?.createdAt);
  const expiresAtMilliseconds = dateMilliseconds(challenge?.expiresAt);
  const phone = normalizedPhone(challenge?.phone);

  if (
    nowMilliseconds === null ||
    createdAtMilliseconds === null ||
    expiresAtMilliseconds === null ||
    !phone ||
    challenge.phone !== phone ||
    challenge.provider !== "firebase" ||
    challenge.status !== "pending" ||
    expiresAtMilliseconds <= nowMilliseconds
  ) {
    throw invalidFirebaseToken();
  }

  return { createdAtMilliseconds, nowMilliseconds, phone };
}

export async function verifyFirebaseEvidence({ idToken, challenge, now }, deps = {}) {
  try {
    const activeChallenge = activeFirebaseChallenge(challenge, now);

    if (typeof idToken !== "string" || !idToken.trim()) {
      throw invalidFirebaseToken();
    }

    const decoded = await deps.adminAuth?.verifyIdToken(idToken);
    const phone = normalizedPhone(decoded?.phone_number);
    const authTime = decoded?.auth_time;

    if (typeof authTime !== "number" || !Number.isFinite(authTime)) {
      throw invalidFirebaseToken();
    }

    const authTimeMilliseconds = authTime * 1_000;

    if (
      !phone ||
      phone !== activeChallenge.phone ||
      decoded?.firebase?.sign_in_provider !== "phone" ||
      !Number.isFinite(authTimeMilliseconds) ||
      authTimeMilliseconds < activeChallenge.createdAtMilliseconds - FIREBASE_CLOCK_SKEW_MS ||
      authTimeMilliseconds > activeChallenge.nowMilliseconds + FIREBASE_CLOCK_SKEW_MS
    ) {
      throw invalidFirebaseToken();
    }

    return phone;
  } catch {
    throw invalidFirebaseToken();
  }
}
