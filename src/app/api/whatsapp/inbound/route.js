import { NextResponse } from "next/server";
import twilio from "twilio";

export async function POST() {
  const twiml = new twilio.twiml.MessagingResponse();

  twiml.message(
    "شكرًا لتواصلك معنا.\n\n" +
      "هذا الرقم مخصص لإرسال الإشعارات الآلية فقط.\n" +
      "لأي استفسار يرجى التواصل على الرقم:\n" +
      "+972507456258",
  );

  return new NextResponse(twiml.toString(), {
    headers: {
      "Content-Type": "text/xml",
    },
  });
}
