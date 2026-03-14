import { getCollection } from "@/lib/db";
import { sendWhatsAppTemplate } from "@/lib/whatsapp";
import { normalizeIsraeliPhone } from "@/lib/phone";

const TZ = "Asia/Jerusalem";
const WINDOW_MINUTES = 5;  
const REMINDER_HOURS = 2;  // 2 hours before

function getIsraelNow(req) {
  // Dev testing: allow ?testTime=2026-02-24T08:35:00
  const { searchParams } = new URL(req.url);
  const testTime = searchParams.get("testTime");
  const base = testTime ? new Date(testTime) : new Date();
  return new Date(base.toLocaleString("en-US", { timeZone: TZ }));
}


function buildIsraelDateTime(dateStr, timeStr) {
  const [yyyy, mm, dd] = (dateStr || "").split("-").map(Number);
  const [hh, min] = (timeStr || "").split(":").map(Number);

  if (!dd || !mm || !yyyy || Number.isNaN(hh) || Number.isNaN(min)) return null;

  const d = new Date(yyyy, mm - 1, dd, hh, min, 0, 0);
  return new Date(d.toLocaleString("en-US", { timeZone: TZ }));
}

export async function GET(req) {
  try {
    //  Protect endpoint
    const secret = req.headers.get("x-cron-secret");
    if (process.env.CRON_SECRET && secret !== process.env.CRON_SECRET) {
      return Response.json({ error: "Unauthorized" }, { status: 401 });
    }

    const { searchParams } = new URL(req.url);
    const dryRun = searchParams.get("dryRun") === "1"; // dev: don’t send WA

    const israelNow = getIsraelNow(req);

    // window: now+2h -> now+2h+5m
    const targetStart = new Date(israelNow.getTime() + REMINDER_HOURS * 60 * 60 * 1000);
    const targetEnd = new Date(targetStart.getTime() + WINDOW_MINUTES * 60 * 1000);
    const date = targetStart.toISOString().split("T")[0]; // "YYYY-MM-DD"

    const appointmentsCollection = await getCollection("appointments");

    const day = await appointmentsCollection.findOne(
      { date },
      { projection: { appointments: 1 } }
    );

    if (!day?.appointments?.length) {
      return Response.json({
        success: true,
        date,
        sent: 0,
        window: { from: targetStart.toISOString(), to: targetEnd.toISOString() },
      });
    }

    let sent = 0;
    const debug = [];

    for (const apt of day.appointments) {
      if (apt?.reminderSent === true) continue;
      const aptDateTime = buildIsraelDateTime(date, apt.time);
      if (!aptDateTime) continue;

      if (aptDateTime >= targetStart && aptDateTime < targetEnd) {
        const phone = normalizeIsraeliPhone(apt.phone);
        const toWhatsApp = phone.startsWith("whatsapp:")
          ? phone
          : phone.startsWith("+")
            ? `whatsapp:${phone}`
            : `whatsapp:+${phone}`;

        if (dryRun || process.env.NODE_ENV === "development") {
          debug.push({
            to: toWhatsApp,
            name: `${apt.firstName || ""} ${apt.lastName || ""}`.trim(),
            time: apt.time,
          });
        } else {
          await sendWhatsAppTemplate({
            to: toWhatsApp,
            templateSid: process.env.TWILIO_TEMPLATE_APPOINTMENT_CUSTUMER_REMINDER,
            variables: {
              1: `${apt.firstName || ""} ${apt.lastName || ""}`.trim() || "عزيزي الزبون",
              2: date,
              3: apt.time,
            },
          });
        }

        await appointmentsCollection.updateOne(
          { date, "appointments._id": apt._id, "appointments.reminderSent": false },
          { $set: { "appointments.$.reminderSent": true } }
        );

        sent++;
      }
    }

    return Response.json({
      success: true,
      date,
      sent,
      window: { from: targetStart.toISOString(), to: targetEnd.toISOString() },
      ...(debug.length ? { debug } : {}),
    });
  } catch (err) {
    console.error("Cron reminder error:", err);
    return Response.json({ error: "Failed" }, { status: 500 });
  }
}