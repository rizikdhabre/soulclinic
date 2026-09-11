import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { otpSecretKey } from "./crypto";
import { OtpError } from "./errors";
import { OTP_GRANT_TTL_MS } from "./constants";

const AAD = Buffer.from("soulclinic:otp:observed-result:v2");

export function isUncommittedFirebaseReservation(result, challenge) {
  return result.operation === "firebase_retry" && result.reservation === true &&
    challenge.provider === "firebase" && ["firebase_sending", "firebase_sent"].includes(result.previousStatus) &&
    (challenge.status === result.previousStatus ||
      (result.previousStatus === "firebase_sending" && challenge.status === "firebase_sent")) &&
    (challenge.verifyAttemptId ?? null) === result.previousAttemptId;
}
export function sealOtpReceipt(result, env = process.env) {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", otpSecretKey("receipt", env), iv);
  cipher.setAAD(AAD);
  const body = Buffer.concat([cipher.update(JSON.stringify(result)), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), body]).toString("base64url");
}

export function openOtpReceipt(receipt, { challenge, operation, now, env = process.env }) {
  try {
    if (typeof receipt !== "string" || receipt.length < 40 || receipt.length > 2048 || !/^[\w-]+$/.test(receipt)) throw new Error();
    const data = Buffer.from(receipt, "base64url");
    const decipher = createDecipheriv("aes-256-gcm", otpSecretKey("receipt", env), data.subarray(0, 12));
    decipher.setAAD(AAD);
    decipher.setAuthTag(data.subarray(12, 28));
    const result = JSON.parse(Buffer.concat([decipher.update(data.subarray(28)), decipher.final()]).toString());
    const firebase = operation === "firebase_verify" || operation === "firebase_retry";
    const verification = operation === "verify" || operation === "firebase_verify";
    if (
      !["send", "verify", "firebase_verify", "firebase_retry"].includes(operation) || result.operation !== operation || result.challengeTokenHash !== challenge.challengeTokenHash ||
      result.purpose !== challenge.purpose || result.phone !== challenge.phone ||
      (result.attemptId !== challenge[operation === "send" ? "sendAttemptId" : "verifyAttemptId"] &&
        !(operation === "firebase_retry" && isUncommittedFirebaseReservation(result, challenge))) ||
      (!firebase && !/^VE[0-9a-f]{32}$/i.test(result.verificationSid)) ||
      (firebase && (challenge.provider !== "firebase" || result.provider !== "firebase" || result.firebaseSendId !== challenge.firebaseSendId)) ||
      (operation === "firebase_retry" && (result.retry !== true || result.expiresAt !== +challenge.expiresAt)) ||
      (operation === "firebase_verify" && (typeof result.uid !== "string" || !result.uid || result.uid.length > 128 ||
        !Number.isSafeInteger(result.authTime) || result.authTime < Math.floor(+challenge.createdAt / 1000) || result.authTime > Math.floor(result.observedAt / 1000) + 60)) ||
      !Number.isFinite(result.observedAt) || result.observedAt < +challenge.createdAt ||
      result.observedAt > +now || !Number.isFinite(result.expiresAt) || result.expiresAt <= +now ||
      result.observedAt >= +challenge.expiresAt ||
      (operation === "send" && result.expiresAt !== +challenge.expiresAt) ||
      (verification && result.expiresAt !== result.observedAt + OTP_GRANT_TTL_MS) ||
      (verification && challenge.purpose === "login" && (!Number.isSafeInteger(result.sessionTtlSeconds) || result.sessionTtlSeconds <= 0)) ||
      (operation === "verify" && result.verificationSid !== challenge.verificationSid)
    ) throw new Error();
    return result;
  } catch {
    throw new OtpError("OTP_RECOVERY_INVALID", 400, "Invalid verification recovery receipt.");
  }
}

// Retry only our idempotent writes; never retry the provider operation here.
export async function persistObservedResult(store, transition, matches) {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const saved = await store.transition(transition);
      if (saved && matches(saved)) return saved;
      const observed = await store.findByTokenHash(transition.challengeTokenHash);
      if (observed && matches(observed)) return observed;
    } catch {
      try {
        const observed = await store.findByTokenHash(transition.challengeTokenHash);
        if (observed && matches(observed)) return observed;
      } catch { /* A later attempt can reconcile an acknowledged-but-lost write. */ }
    }
  }
  throw new OtpError("OTP_PERSISTENCE_FAILED", 503, "Verification state could not be saved.");
}
