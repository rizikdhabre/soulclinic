import { NextResponse } from "next/server";
import { normalizeIsraeliPhone } from "@/lib/phone";
import {
  claimOtpSendOperation,
  completeOtpProviderAttempt,
  completeOtpSendOperation,
  getRetryAfterSeconds,
  maskPhone,
  setOtpSendRetryWait,
  startOtpProviderAttempt,
} from "@/lib/otpSecurity";
import {
  classifyTwilioSendError,
  getOtpExpiresAt,
  getOtpProvider,
  getOtpSuccessMessage,
  getStoredOtpCode,
  sendPhoneVerification,
} from "@/lib/twilioOTP";

const MAX_PROVIDER_ATTEMPTS = 3;

function getRetryDelayMs() {
  const configuredDelay = Number(process.env.OTP_PROVIDER_RETRY_DELAY_MS);
  return Number.isFinite(configuredDelay) && configuredDelay >= 0
    ? configuredDelay
    : 10000;
}

function wait(ms) {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function getSafeOtpStartMessage(errorCode) {
  switch (errorCode) {
    case "OTP_RATE_LIMITED":
      return "A verification code was requested recently. Please wait before trying again.";
    case "OTP_REQUEST_IN_PROGRESS":
      return "A verification request is already being processed.";
    case "OTP_SERVICE_NOT_CONFIGURED":
      return "OTP service is not configured.";
    case "OTP_SEND_PENDING":
      return "The verification request may still be processing. Please wait before trying again.";
    case "OTP_SEND_RETRIES_EXHAUSTED":
      return "Failed to send OTP after multiple attempts. Please wait before trying again.";
    case "INVALID_PHONE":
      return "Invalid phone number.";
    default:
      return "Failed to send OTP.";
  }
}

function getHttpStatusForSendError(errorCode) {
  switch (errorCode) {
    case "OTP_RATE_LIMITED":
      return 429;
    case "OTP_REQUEST_IN_PROGRESS":
      return 409;
    case "INVALID_PHONE":
      return 400;
    case "OTP_SERVICE_NOT_CONFIGURED":
      return 500;
    case "TWILIO_AUTH_FAILED":
      return 502;
    case "OTP_SEND_PENDING":
      return 503;
    default:
      return 500;
  }
}

function createOtpStartErrorResponse({
  errorCode,
  retryAfterSeconds,
  status,
}) {
  return NextResponse.json(
    {
      error: errorCode,
      message: getSafeOtpStartMessage(errorCode),
      ...(retryAfterSeconds ? { retryAfterSeconds } : {}),
    },
    { status: status || getHttpStatusForSendError(errorCode) },
  );
}

async function runProviderSendAttempts({ operation, phone }) {
  const retryDelayMs = getRetryDelayMs();

  for (let attemptNumber = 1; attemptNumber <= MAX_PROVIDER_ATTEMPTS; attemptNumber += 1) {
    const attempt = await startOtpProviderAttempt({
      operationId: operation._id,
      phone,
      attemptNumber,
      provider: getOtpProvider(),
    });

    try {
      const verification = await sendPhoneVerification(phone);

      await completeOtpProviderAttempt(attempt._id, {
        status: "SENT",
        provider: verification.provider,
        providerHttpStatus: 200,
        providerErrorCode: null,
        errorCategory: null,
        retryable: false,
      });

      await completeOtpSendOperation(operation._id, {
        status: "SENT",
        provider: verification.provider,
        providerStatus: verification.status,
        errorCode: null,
        errorCategory: null,
      });

      return {
        success: true,
        verification,
        providerAttempts: attemptNumber,
      };
    } catch (error) {
      const classification = classifyTwilioSendError(error);
      const finalAttempt = attemptNumber >= MAX_PROVIDER_ATTEMPTS;
      const finalErrorCode =
        classification.retryable && finalAttempt
          ? "OTP_SEND_RETRIES_EXHAUSTED"
          : classification.errorCode;

      console.error("OTP provider send attempt failed:", {
        operationId: String(operation._id),
        attemptNumber,
        phone: maskPhone(phone),
        provider: getOtpProvider(),
        providerHttpStatus: classification.providerHttpStatus,
        providerErrorCode: classification.providerErrorCode,
        errorCode: finalErrorCode,
        errorCategory: classification.errorCategory,
        retryable: classification.retryable,
        unknown: classification.unknown,
      });

      await completeOtpProviderAttempt(attempt._id, {
        status: classification.unknown ? "UNKNOWN" : "FAILED",
        provider: getOtpProvider(),
        providerHttpStatus: classification.providerHttpStatus,
        providerErrorCode: classification.providerErrorCode,
        errorCategory: classification.errorCategory,
        retryable: classification.retryable,
      });

      if (classification.unknown) {
        await completeOtpSendOperation(operation._id, {
          status: "UNKNOWN",
          provider: getOtpProvider(),
          providerStatus: null,
          errorCode: "OTP_SEND_PENDING",
          errorCategory: classification.errorCategory,
        });

        return {
          success: false,
          errorCode: "OTP_SEND_PENDING",
          status: getHttpStatusForSendError("OTP_SEND_PENDING"),
          retryAfterSeconds: getRetryAfterSeconds(operation.cooldownUntil),
          providerAttempts: attemptNumber,
        };
      }

      if (!classification.retryable || finalAttempt) {
        await completeOtpSendOperation(operation._id, {
          status: "FAILED",
          provider: getOtpProvider(),
          providerStatus: null,
          errorCode: finalErrorCode,
          errorCategory: classification.errorCategory,
        });

        return {
          success: false,
          errorCode: finalErrorCode,
          status: getHttpStatusForSendError(finalErrorCode),
          retryAfterSeconds: getRetryAfterSeconds(operation.cooldownUntil),
          providerAttempts: attemptNumber,
        };
      }

      await setOtpSendRetryWait(operation._id, {
        errorCode: classification.errorCode,
        errorCategory: classification.errorCategory,
      });

      await wait(retryDelayMs);
    }
  }

  await completeOtpSendOperation(operation._id, {
    status: "FAILED",
    provider: getOtpProvider(),
    providerStatus: null,
    errorCode: "OTP_SEND_RETRIES_EXHAUSTED",
    errorCategory: "PROVIDER_TEMPORARY",
  });

  return {
    success: false,
    errorCode: "OTP_SEND_RETRIES_EXHAUSTED",
    status: 500,
    retryAfterSeconds: getRetryAfterSeconds(operation.cooldownUntil),
    providerAttempts: MAX_PROVIDER_ATTEMPTS,
  };
}

export async function POST(req) {
  try {
    const { phone: rawPhone } = await req.json();
    const phone = normalizeIsraeliPhone(rawPhone);

    if (!phone) {
      return createOtpStartErrorResponse({
        errorCode: "INVALID_PHONE",
        status: 400,
      });
    }

    const claim = await claimOtpSendOperation(phone);

    if (!claim.ok) {
      return createOtpStartErrorResponse({
        errorCode: claim.error,
        retryAfterSeconds: claim.retryAfterSeconds,
        status: claim.status,
      });
    }

    const result = await runProviderSendAttempts({
      operation: claim.operation,
      phone,
    });

    if (!result.success) {
      return createOtpStartErrorResponse({
        errorCode: result.errorCode,
        retryAfterSeconds: result.retryAfterSeconds,
        status: result.status,
      });
    }

    const expiresAt = getOtpExpiresAt();
    const storedOtpCode = getStoredOtpCode();

    console.info("OTP start request completed", {
      operationId: String(claim.operation._id),
      provider: result.verification.provider || getOtpProvider(),
      providerAttempts: result.providerAttempts,
      phone: maskPhone(phone),
    });

    return NextResponse.json({
      success: true,
      provider: result.verification.provider,
      status: result.verification.status,
      expiresAt: expiresAt.toISOString(),
      mode: storedOtpCode === "twilio-verify" ? "twilio" : "development",
      message: getOtpSuccessMessage(),
      retryAfterSeconds: getRetryAfterSeconds(claim.operation.cooldownUntil),
    });
  } catch (error) {
    console.error("OTP start failed:", {
      provider: getOtpProvider(),
      code: error?.code,
      status: error?.status,
      message: error?.message,
    });

    if (error?.code === "TWILIO_VERIFY_NOT_CONFIGURED") {
      return createOtpStartErrorResponse({
        errorCode: "OTP_SERVICE_NOT_CONFIGURED",
        status: 500,
      });
    }

    return createOtpStartErrorResponse({
      errorCode: "OTP_SEND_FAILED",
      status: 500,
    });
  }
}
