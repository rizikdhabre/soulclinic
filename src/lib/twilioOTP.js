import { getTwilioClient, getTwilioVerifyConfig } from "./twilio";

const DEVELOPMENT_OTP_CODE = process.env.OTP_DEV_CODE || "123456";
const OTP_TTL_MS = 1000 * 60 * 5;
const TWILIO_PLACEHOLDER_CODE = "twilio-verify";

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
