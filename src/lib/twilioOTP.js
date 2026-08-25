import { getTwilioClient, getTwilioVerifyConfig } from "./twilio";

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
  "UND_ERR_SOCKET",
]);

function getErrorStatus(error) {
  return Number(error?.status || error?.statusCode || error?.response?.status);
}

function getErrorCode(error) {
  return error?.code || error?.cause?.code || error?.response?.code;
}

function getErrorMessage(error) {
  return String(error?.message || error?.response?.message || "");
}

function isServerErrorStatus(status) {
  return Number.isInteger(status) && status >= 500 && status <= 599;
}

function getErrorLayers(error) {
  const layers = [];
  const pending = [error];
  const visited = new Set();

  while (pending.length > 0 && layers.length < 8) {
    const value = pending.shift();
    if (
      !value ||
      (typeof value !== "object" && typeof value !== "function") ||
      visited.has(value)
    ) {
      continue;
    }

    visited.add(value);
    layers.push(value);
    pending.push(value.cause, value.response);
  }

  return layers;
}

function getAmbiguousDelivery(error) {
  let providerErrorCode;
  let ambiguousMessage = false;

  for (const layer of getErrorLayers(error)) {
    if (!providerErrorCode && UNKNOWN_NETWORK_CODES.has(layer?.code)) {
      providerErrorCode = layer.code;
    }

    const message = String(layer?.message || "").toLowerCase();
    if (!providerErrorCode) {
      providerErrorCode = [...UNKNOWN_NETWORK_CODES].find((code) =>
        message.includes(code.toLowerCase()),
      );
    }
    if (message.includes("timeout") || message.includes("socket")) {
      ambiguousMessage = true;
    }
  }

  return providerErrorCode || ambiguousMessage
    ? { providerErrorCode: providerErrorCode ?? getErrorCode(error) }
    : null;
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
  const ambiguousDelivery = getAmbiguousDelivery(error);

  if (ambiguousDelivery) {
    return {
      errorCode: "OTP_SEND_PENDING",
      errorCategory: "UNKNOWN_PROVIDER_RESULT",
      retryable: false,
      unknown: true,
      providerHttpStatus: status || null,
      providerErrorCode:
        ambiguousDelivery.providerErrorCode ?? providerErrorCode,
    };
  }

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

  if (isServerErrorStatus(status)) {
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

  return {
    errorCode: "OTP_SEND_FAILED",
    errorCategory: "PROVIDER_UNKNOWN_FAILURE",
    retryable: false,
    unknown: false,
    providerHttpStatus: status || null,
    providerErrorCode,
  };
}

export function classifyTwilioVerifyError(error) {
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

  if (status === 400 || status === 404) {
    return {
      errorCode: "INVALID_OTP",
      errorCategory: "PROVIDER_VALIDATION",
      retryable: false,
      unknown: false,
      providerHttpStatus: status,
      providerErrorCode,
    };
  }

  if (status === 429) {
    return {
      errorCode: "OTP_VERIFY_RATE_LIMITED",
      errorCategory: "PROVIDER_RATE_LIMIT",
      retryable: false,
      unknown: false,
      providerHttpStatus: status,
      providerErrorCode,
    };
  }

  if (
    isServerErrorStatus(status) ||
    RETRYABLE_NETWORK_CODES.has(providerErrorCode) ||
    UNKNOWN_NETWORK_CODES.has(providerErrorCode) ||
    message.includes("timeout") ||
    message.includes("socket hang up")
  ) {
    return {
      errorCode: "OTP_VERIFY_TEMPORARY_FAILURE",
      errorCategory: "PROVIDER_TEMPORARY",
      retryable: true,
      unknown: false,
      providerHttpStatus: status || null,
      providerErrorCode,
    };
  }

  return {
    errorCode: "OTP_VERIFY_FAILED",
    errorCategory:
      status === 401 || status === 403 ? "AUTH" : "PROVIDER_PERMANENT",
    retryable: false,
    unknown: false,
    providerHttpStatus: status || null,
    providerErrorCode,
  };
}

export async function sendTwilioVerification(phone) {
  const client = getTwilioClient();
  const { serviceSid } = getTwilioVerifyConfig();
  return client.verify.v2
    .services(serviceSid)
    .verifications.create({
      to: phone,
      channel: "sms",
    });
}

export async function verifyTwilioCode(phone, code) {
  const client = getTwilioClient();
  const { serviceSid } = getTwilioVerifyConfig();
  return client.verify.v2
    .services(serviceSid)
    .verificationChecks.create({
      to: phone,
      code,
    });
}
