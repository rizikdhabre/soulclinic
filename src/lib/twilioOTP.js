import { getTwilioClient, getTwilioVerifyConfig } from "./twilio";

const DEVELOPMENT_OTP_CODE = process.env.OTP_DEV_CODE || "123456";
const OTP_TTL_MS = 1000 * 60 * 5;
const TWILIO_PLACEHOLDER_CODE = "twilio-verify";
const RETRYABLE_HTTP_STATUSES = new Set([500, 502, 503, 504]);
const PERMANENT_HTTP_STATUSES = new Set([400, 401, 403, 404, 429]);
const RETRYABLE_NETWORK_CODES = new Set([
  "ENOTFOUND",
  "EAI_AGAIN",
  "ECONNREFUSED",
  "EHOSTUNREACH",
  "ENETUNREACH",
]);
const UNKNOWN_NETWORK_CODES = new Set([
  "ETIMEDOUT",
  "ESOCKETTIMEDOUT",
  "ECONNRESET",
  "EPIPE",
]);

export function isDevelopmentOtpMode() {
  return process.env.NODE_ENV === "development";
}

export function getOtpProvider() {
  return isDevelopmentOtpMode() ? "development" : "twilio";
}

export function getOtpExpiresAt() {
  return new Date(Date.now() + OTP_TTL_MS);
}

export function getStoredOtpCode() {
  return isDevelopmentOtpMode() ? DEVELOPMENT_OTP_CODE : TWILIO_PLACEHOLDER_CODE;
}

export function getOtpSuccessMessage() {
  if (isDevelopmentOtpMode()) {
    return `OTP sent successfully. Development code: ${DEVELOPMENT_OTP_CODE}`;
  }

  return "OTP sent successfully";
}

function getErrorStatus(error) {
  return Number(error?.status || error?.statusCode || error?.response?.status);
}

function getErrorCode(error) {
  return error?.code || error?.cause?.code || error?.response?.code;
}

function getErrorMessage(error) {
  return String(error?.message || error?.response?.message || "");
}

export function classifyTwilioSendError(error) {
  if (error?.code === "TWILIO_VERIFY_NOT_CONFIGURED") {
    return {
      errorCode: "OTP_SERVICE_NOT_CONFIGURED",
      errorCategory: "CONFIGURATION",
      retryable: false,
      unknown: false,
      providerHttpStatus: null,
      providerErrorCode: error.code,
    };
  }

  const status = getErrorStatus(error);
  const providerErrorCode = getErrorCode(error);
  const message = getErrorMessage(error).toLowerCase();

  if (status === 401 || status === 403) {
    return {
      errorCode: "TWILIO_AUTH_FAILED",
      errorCategory: "AUTH",
      retryable: false,
      unknown: false,
      providerHttpStatus: status,
      providerErrorCode,
    };
  }

  if (status === 429) {
    return {
      errorCode: "OTP_RATE_LIMITED",
      errorCategory: "PROVIDER_RATE_LIMIT",
      retryable: false,
      unknown: false,
      providerHttpStatus: status,
      providerErrorCode,
    };
  }

  if (status === 400 || status === 404) {
    return {
      errorCode: "INVALID_PHONE",
      errorCategory: "PROVIDER_VALIDATION",
      retryable: false,
      unknown: false,
      providerHttpStatus: status,
      providerErrorCode,
    };
  }

  if (RETRYABLE_HTTP_STATUSES.has(status)) {
    return {
      errorCode: "TWILIO_REQUEST_FAILED",
      errorCategory: "PROVIDER_TEMPORARY",
      retryable: true,
      unknown: false,
      providerHttpStatus: status,
      providerErrorCode,
    };
  }

  if (PERMANENT_HTTP_STATUSES.has(status)) {
    return {
      errorCode: "TWILIO_REQUEST_FAILED",
      errorCategory: "PROVIDER_PERMANENT",
      retryable: false,
      unknown: false,
      providerHttpStatus: status,
      providerErrorCode,
    };
  }

  if (RETRYABLE_NETWORK_CODES.has(providerErrorCode)) {
    return {
      errorCode: "TWILIO_REQUEST_FAILED",
      errorCategory: "NETWORK_BEFORE_REQUEST",
      retryable: true,
      unknown: false,
      providerHttpStatus: status || null,
      providerErrorCode,
    };
  }

  if (
    UNKNOWN_NETWORK_CODES.has(providerErrorCode) ||
    message.includes("timeout") ||
    message.includes("socket hang up")
  ) {
    return {
      errorCode: "OTP_SEND_PENDING",
      errorCategory: "UNKNOWN_PROVIDER_RESULT",
      retryable: false,
      unknown: true,
      providerHttpStatus: status || null,
      providerErrorCode,
    };
  }

  return {
    errorCode: "OTP_SEND_FAILED",
    errorCategory: "PROVIDER_UNKNOWN_FAILURE",
    retryable: false,
    unknown: false,
    providerHttpStatus: status || null,
    providerErrorCode,
  };
}

export async function sendPhoneVerification(phone) {
  if (isDevelopmentOtpMode()) {
    console.info("OTP send provider", { provider: "development" });
    return {
      provider: "development",
      status: "pending",
    };
  }

  const client = getTwilioClient();
  const { serviceSid } = getTwilioVerifyConfig();

  const verification = await client.verify.v2
    .services(serviceSid)
    .verifications.create({
      to: phone,
      channel: "sms",
    });

  console.info("OTP send provider", { provider: "twilio" });

  return {
    provider: "twilio",
    status: verification.status,
    sid: verification.sid,
  };
}

export async function verifyPhoneCode(phone, code) {
  if (isDevelopmentOtpMode()) {
    console.info("OTP verify provider", { provider: "development" });
    return code === DEVELOPMENT_OTP_CODE;
  }

  const client = getTwilioClient();
  const { serviceSid } = getTwilioVerifyConfig();

  const verificationCheck = await client.verify.v2
    .services(serviceSid)
    .verificationChecks.create({
      to: phone,
      code,
    });

  console.info("OTP verify provider", { provider: "twilio" });

  return verificationCheck.status === "approved";
}
