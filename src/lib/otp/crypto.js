import { createHash, createHmac, randomBytes } from "node:crypto";
import { OtpError } from "./errors";

export function createBearerToken() {
  return randomBytes(32).toString("base64url");
}

export function hashBearerToken(token) {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

export function otpSecretKey(domain, env = process.env) {
  const secret = env.CUSTOMER_SESSION_SECRET;
  if (typeof secret !== "string" || secret.length < 32) {
    throw new OtpError("OTP_SERVICE_NOT_CONFIGURED", 503, "Verification is unavailable.");
  }
  return createHmac("sha256", secret).update(`soulclinic:otp:${domain}:v2`).digest();
}

export function deriveBookingToken(challengeToken, env = process.env) {
  return createHmac("sha256", otpSecretKey("booking-grant", env)).update(challengeToken).digest("base64url");
}
