import twilio from "twilio";

let cachedClient;

export function getTwilioVerifyConfig() {
  const accountSid = process.env.TWILIO_ACCOUNT_SID;
  const authToken = process.env.TWILIO_AUTH_TOKEN;
  const serviceSid = process.env.TWILIO_VERIFY_SERVICE_SID;

  if (!accountSid || !authToken || !serviceSid) {
    const error = new Error(
      "Twilio Verify is not configured. Set TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, and TWILIO_VERIFY_SERVICE_SID.",
    );
    error.code = "TWILIO_VERIFY_NOT_CONFIGURED";
    throw error;
  }

  return {
    accountSid,
    authToken,
    serviceSid,
  };
}

export function getTwilioClient() {
  if (!cachedClient) {
    const { accountSid, authToken } = getTwilioVerifyConfig();
    cachedClient = twilio(accountSid, authToken);
  }

  return cachedClient;
}
