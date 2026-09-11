import { isOtpCorrelationId, isOtpIsoTime } from "./diagnostics";

export class OtpError extends Error {
  constructor(code, status, message, retryAfterSeconds, metadata = {}) {
    super(message);
    this.name = "OtpError";
    this.code = code;
    this.status = status;
    Object.assign(this, otpErrorMetadata({ ...metadata, retryAfterSeconds }));
  }
}

export function otpErrorMetadata(error = {}) {
  const metadata = {};
  if (isOtpCorrelationId(error.correlationId)) metadata.correlationId = error.correlationId;
  for (const key of ["retryAt", "serverTime", "phoneRetryAt"]) {
    if (isOtpIsoTime(error[key])) metadata[key] = error[key];
  }
  if (Number.isInteger(error.retryAfterSeconds) && error.retryAfterSeconds > 0 && error.retryAfterSeconds <= 86400) {
    metadata.retryAfterSeconds = error.retryAfterSeconds;
  }
  if (["phone", "source", "global"].includes(error.restrictionScope)) {
    metadata.restrictionScope = error.restrictionScope;
  }
  return metadata;
}

export function otpRetryMetadata(retryAt, now, restrictionScope = "phone") {
  const deadline = new Date(retryAt).getTime();
  const remaining = deadline - now.getTime();
  if (!Number.isFinite(remaining) || remaining <= 0) return {};
  return {
    retryAt: new Date(deadline).toISOString(),
    serverTime: now.toISOString(),
    retryAfterSeconds: Math.ceil(remaining / 1000),
    restrictionScope,
  };
}

export function attachOtpAttemptMetadata(error, { correlationId, phoneRetryAt, now }) {
  if (isOtpCorrelationId(correlationId)) error.correlationId = correlationId;
  error.serverTime = now.toISOString();
  const phone = otpRetryMetadata(phoneRetryAt, now);
  if (error.restrictionScope === "source" || error.restrictionScope === "global") {
    // Preserve the aggregate-source deadline separately from this phone's reservation.
    if (phone.retryAt) error.phoneRetryAt = phone.retryAt;
  } else if (phone.retryAt && (!error.retryAt || Date.parse(error.retryAt) < Date.parse(phone.retryAt))) {
    Object.assign(error, phone);
  }
  return error;
}

export async function otpPersistence(operation) {
  try {
    return await operation();
  } catch (error) {
    if (error instanceof OtpError) throw error;
    throw new OtpError("OTP_PERSISTENCE_FAILED", 503, "OTP state could not be saved or read.");
  }
}
