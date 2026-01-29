import twilio from "twilio";

const client = twilio(
  process.env.TWILIO_ACCOUNT_SID,
  process.env.TWILIO_AUTH_TOKEN
);

export async function sendWhatsAppTemplate({
  to,
  templateSid,
  variables,
}) {
  return client.messages.create({
    from: process.env.TWILIO_WHATSAPP_FROM,
    to,
    contentSid: templateSid,
    contentVariables: JSON.stringify(variables),
  });
}
