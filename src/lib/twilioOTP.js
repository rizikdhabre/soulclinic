import { getTwilioClient, getTwilioVerifyConfig } from "./twilio";

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
  "ECONNABORTED",
  "ECONNRESET",
  "EPIPE",
  "ABORT_ERR",
  "ERR_CANCELED",
  "UND_ERR_SOCKET",
  "UND_ERR_HEADERS_TIMEOUT",
  "UND_ERR_BODY_TIMEOUT",
]);

function getErrorStatus(error) {
  for (const layer of getErrorLayers(error)) {
    for (const value of [layer.status, layer.statusCode]) {
      const status = typeof value === "number" ? value :
        typeof value === "string" && /^\d{3}$/.test(value) ? Number(value) : NaN;
      if (Number.isInteger(status) && status >= 100 && status <= 599) return status;
    }
  }
  return null;
}

function getErrorCode(error) {
  for (const layer of getErrorLayers(error)) {
    const code = layer.code;
    // Do not project arbitrary provider payloads or source identifiers.
    if (
      RETRYABLE_NETWORK_CODES.has(code) || UNKNOWN_NETWORK_CODES.has(code) ||
      (typeof code === "number" && Number.isInteger(code) && code >= 10000 && code <= 99999) ||
      (typeof code === "string" && /^\d{5}$/.test(code))
    ) return code;
  }
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
    if (message.includes("timeout") || message.includes("timed out") || message.includes("socket")) {
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

  if (ambiguousDelivery || isServerErrorStatus(status) || status === 408 || status === 499) {
    return {
      errorCode: "OTP_SEND_PENDING",
      errorCategory: "UNKNOWN_PROVIDER_RESULT",
      retryable: false,
      unknown: true,
      providerHttpStatus: status || null,
      providerErrorCode:
        ambiguousDelivery?.providerErrorCode ?? providerErrorCode,
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

  if (status >= 400 && status <= 499) {
    return {
      errorCode: "OTP_SEND_FAILED",
      errorCategory: "PROVIDER_PERMANENT",
      retryable: false,
      unknown: false,
      providerHttpStatus: status,
      providerErrorCode,
    };
  }

  if (!status && RETRYABLE_NETWORK_CODES.has(providerErrorCode)) {
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
    errorCode: "OTP_SEND_PENDING",
    errorCategory: "UNKNOWN_PROVIDER_RESULT",
    retryable: false,
    unknown: true,
    providerHttpStatus: status || null,
    providerErrorCode,
  };
}

export function classifyTwilioVerifyError(error) {
  if (error?.code === "TWILIO_VERIFICATION_SID_INVALID") {
    return {
      errorCode: "INVALID_OTP",
      errorCategory: "PROVIDER_VALIDATION",
      retryable: false,
      unknown: false,
      providerHttpStatus: null,
      providerErrorCode: error.code,
    };
  }

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

  // A check may consume approval before its response is lost. Never repeat it.
  if (ambiguousDelivery || isServerErrorStatus(status) || status === 408 || status === 499) {
    return {
      errorCode: "OTP_VERIFY_TEMPORARY_FAILURE",
      errorCategory: "UNKNOWN_PROVIDER_RESULT",
      retryable: false,
      unknown: true,
      providerHttpStatus: status || null,
      providerErrorCode: ambiguousDelivery?.providerErrorCode ?? providerErrorCode,
    };
  }

  if (status === 401 || status === 403) {
    return {
      errorCode: "OTP_VERIFY_FAILED",
      errorCategory: "AUTH",
      retryable: false,
      unknown: false,
      providerHttpStatus: status,
      providerErrorCode,
    };
  }

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

  if (!status && RETRYABLE_NETWORK_CODES.has(providerErrorCode)) {
    return {
      errorCode: "OTP_VERIFY_TEMPORARY_FAILURE",
      errorCategory: "NETWORK_BEFORE_REQUEST",
      retryable: true,
      unknown: false,
      providerHttpStatus: status || null,
      providerErrorCode,
    };
  }

  if (status >= 400 && status <= 499) {
    return {
      errorCode: "OTP_VERIFY_FAILED",
      errorCategory: "PROVIDER_PERMANENT",
      retryable: false,
      unknown: false,
      providerHttpStatus: status,
      providerErrorCode,
    };
  }

  return {
    errorCode: "OTP_VERIFY_TEMPORARY_FAILURE",
    errorCategory: "UNKNOWN_PROVIDER_RESULT",
    retryable: false,
    unknown: true,
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

export async function verifyTwilioCode(phone, code, verificationSid) {
  if (
    typeof verificationSid !== "string" || verificationSid.length !== 34 ||
    !/^VE[0-9a-fA-F]{32}$/.test(verificationSid)
  ) {
    const error = new Error("A valid Twilio verification SID is required.");
    error.code = "TWILIO_VERIFICATION_SID_INVALID";
    throw error;
  }

  const client = getTwilioClient();
  const { serviceSid } = getTwilioVerifyConfig();
  return client.verify.v2
    .services(serviceSid)
    .verificationChecks.create({
      verificationSid,
      code,
    });
}
