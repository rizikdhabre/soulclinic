import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

export function createBearerToken() {
  return randomBytes(32).toString("base64url");
}

export function hashBearerToken(token) {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

export function safeCompareDevelopmentCode(submitted, configured) {
  if (typeof submitted !== "string" || typeof configured !== "string") return false;

  const submittedBuffer = Buffer.from(submitted, "utf8");
  const configuredBuffer = Buffer.from(configured, "utf8");
  if (submittedBuffer.length !== configuredBuffer.length) return false;

  return timingSafeEqual(submittedBuffer, configuredBuffer);
}
