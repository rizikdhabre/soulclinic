import twilio from "twilio";
import { optOutReturnRemindersByPhone } from "@/lib/returnReminderPreferences";
import { normalizeIsraeliPhone } from "@/lib/phone";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const WHATSAPP_ADDRESS = /^whatsapp:\+[1-9]\d{6,14}$/;
const MAX_BODY_LENGTH = 64_000;
const HEADERS = { "Cache-Control": "private, no-store, max-age=0" };

function failure(status, error) {
  return Response.json({ error }, { status, headers: HEADERS });
}

function reply(message) {
  const twiml = new twilio.twiml.MessagingResponse();
  if (message) twiml.message(message);
  return new Response(twiml.toString(), {
    headers: { ...HEADERS, "Content-Type": "text/xml; charset=utf-8" },
  });
}

function configuration() {
  const authToken = process.env.TWILIO_AUTH_TOKEN?.trim();
  const publicUrl = process.env.TWILIO_INBOUND_WEBHOOK_URL?.trim();
  const recipient = process.env.TWILIO_WHATSAPP_FROM?.trim();
  if (!authToken || !publicUrl || !WHATSAPP_ADDRESS.test(recipient || "")) return null;
  try {
    const url = new URL(publicUrl);
    if (url.protocol !== "https:" || url.username || url.password || url.hash) return null;
  } catch {
    return null;
  }
  return { authToken, publicUrl, recipient };
}

function isOptOut(body) {
  const normalized = body.normalize("NFKD")
    .replace(/[\u0610-\u061a\u064b-\u065f\u0670\u06d6-\u06ed]/g, "")
    .replace(/[أإآٱ]/g, "ا")
    .replace(/ـ/g, "")
    .trim().toUpperCase();
  return normalized === "ايقاف" || normalized === "STOP" || normalized === "UNSUBSCRIBE";
}

async function readFormBody(request) {
  if (!request.body) return "";
  const reader = request.body.getReader();
  const decoder = new TextDecoder();
  let size = 0;
  let body = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_BODY_LENGTH) {
        await reader.cancel();
        throw Object.assign(new Error("Body too large"), { code: "BODY_TOO_LARGE" });
      }
      body += decoder.decode(value, { stream: true });
    }
    return body + decoder.decode();
  } finally {
    reader.releaseLock();
  }
}

export async function POST(request) {
  const config = configuration();
  if (!config) return failure(503, "WHATSAPP_INBOUND_UNAVAILABLE");
  if (!request.headers.get("content-type")?.toLowerCase().startsWith("application/x-www-form-urlencoded")) {
    return failure(415, "INVALID_WHATSAPP_REQUEST");
  }
  let params;
  try {
    if (Number(request.headers.get("content-length")) > MAX_BODY_LENGTH) {
      return failure(413, "INVALID_WHATSAPP_REQUEST");
    }
    const body = await readFormBody(request);
    params = Object.create(null);
    for (const [key, value] of new URLSearchParams(body)) {
      // Preserve every field, including repeated future Twilio parameters.
      if (Object.hasOwn(params, key)) params[key] = [].concat(params[key], value);
      else params[key] = value;
    }
    if (!twilio.validateRequest(config.authToken, request.headers.get("x-twilio-signature") || "", config.publicUrl, params)) {
      return failure(403, "INVALID_TWILIO_SIGNATURE");
    }
  } catch (error) {
    return failure(error?.code === "BODY_TOO_LARGE" ? 413 : 400, "INVALID_WHATSAPP_REQUEST");
  }

  if (typeof params.From !== "string" || !WHATSAPP_ADDRESS.test(params.From) ||
      typeof params.To !== "string" || (params.Body !== undefined && typeof params.Body !== "string") ||
      (params.OptOutType !== undefined && typeof params.OptOutType !== "string")) {
    return failure(400, "INVALID_WHATSAPP_REQUEST");
  }
  if (params.To !== config.recipient) return failure(403, "INVALID_WHATSAPP_RECIPIENT");

  if (params.OptOutType === "STOP" || isOptOut(params.Body || "")) {
    const phone = normalizeIsraeliPhone(params.From.slice("whatsapp:".length));
    if (!phone || typeof params.MessageSid !== "string" || !/^SM[0-9a-f]{32}$/i.test(params.MessageSid)) {
      return failure(400, "INVALID_WHATSAPP_REQUEST");
    }
    try {
      const result = await optOutReturnRemindersByPhone({ phone, messageSid: params.MessageSid });
      // Advanced Opt-Out already replied. A replay after admin re-enrollment
      // must also avoid falsely confirming that permission is now disabled.
      return reply(params.OptOutType === "STOP" || !result.unsubscribed
        ? undefined : "تم إيقاف تذكيرات العودة للعيادة.");
    } catch {
      return failure(500, "WHATSAPP_OPT_OUT_FAILED");
    }
  }

  // Provider START is not the customer's explicit consent to this program.
  if (params.OptOutType === "START" || params.OptOutType === "HELP") return reply();

  return reply(
    "شكرًا لتواصلك معنا.\n\n" +
      "هذا الرقم مخصص لإرسال الإشعارات الآلية فقط.\n" +
      "لأي استفسار يرجى التواصل على الرقم:\n" +
      "+972507456258",
  );
}
