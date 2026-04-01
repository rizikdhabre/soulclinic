import { getCollection } from "@/lib/db";
import { sendWhatsAppTemplate } from "@/lib/whatsapp";
import { normalizeIsraeliPhone } from "@/lib/phone";

const TZ = "Asia/Jerusalem";
const WINDOW_MINUTES = 10;
const REMINDER_HOURS = 2;

/**
 * Extract Israel date/time as plain numbers using Intl (no Date shifting).
 * Supports ?testTime= for manual testing.
 */
function getIsraelParts(req) {
  const { searchParams } = new URL(req.url);
  const testTime = searchParams.get("testTime");
  const now = testTime ? new Date(testTime) : new Date();

  const fmt = new Intl.DateTimeFormat("en-CA", {
    timeZone: TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });

  const parts = {};
  for (const { type, value } of fmt.formatToParts(now)) {
    parts[type] = value;
  }

  return {
    date: `${parts.year}-${parts.month}-${parts.day}`,
    hour: Number(parts.hour),
    minute: Number(parts.minute),
    totalMinutes: Number(parts.hour) * 60 + Number(parts.minute),
  };
}

/** Convert "HH:MM" string to total minutes since midnight */
function timeToMinutes(timeStr) {
  const [hh, min] = (timeStr || "").split(":").map(Number);
  if (Number.isNaN(hh) || Number.isNaN(min)) return null;
  return hh * 60 + min;
}

/** Convert total minutes to "HH:MM" for display */
function minutesToTime(totalMin) {
  const h = Math.floor((totalMin % 1440) / 60);
  const m = totalMin % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

/** Get next date "YYYY-MM-DD" */
function getNextDate(dateStr) {
  const d = new Date(dateStr + "T12:00:00Z");
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().split("T")[0];
}

export async function GET(req) {
  try {
    // Protect endpoint
    const secret = req.headers.get("x-cron-secret");
    if (process.env.CRON_SECRET && secret !== process.env.CRON_SECRET) {
      return Response.json({ error: "Unauthorized" }, { status: 401 });
    }

    const { searchParams } = new URL(req.url);
    const dryRun = searchParams.get("dryRun") === "1";

    // Get Israel time as plain numbers (no double-conversion bug)
    const israel = getIsraelParts(req);

    // Target: appointments happening REMINDER_HOURS from now (in minutes)
    const targetMinutes = israel.totalMinutes + REMINDER_HOURS * 60;
    const windowStart = targetMinutes - 1;
    const windowEnd = targetMinutes + WINDOW_MINUTES;

    // If target crosses midnight, query tomorrow's date
    const queryDate =
      targetMinutes >= 1440 ? getNextDate(israel.date) : israel.date;


    const appointmentsCollection = await getCollection("appointments");

    const day = await appointmentsCollection.findOne(
      { date: queryDate },
      { projection: { appointments: 1 } },
    );

    if (!day?.appointments?.length) {
      return Response.json({
        success: true,
        date: queryDate,
        israelNow: `${israel.date} ${String(israel.hour).padStart(2, "0")}:${String(israel.minute).padStart(2, "0")}`,
        sent: 0,
        window: {
          from: minutesToTime(windowStart),
          to: minutesToTime(windowEnd),
        },
      });
    }

    let sent = 0;
    let failed = 0;
    const debug = [];
    const errors = [];

    for (const apt of day.appointments) {
      if (apt?.reminderSent === true) continue;

      const aptMinutes = timeToMinutes(apt.time);
      if (aptMinutes === null) continue;

      // If target crosses midnight, adjust appointment minutes
      const compareMinutes =
        targetMinutes >= 1440 ? aptMinutes + 1440 : aptMinutes;

      const isMatch =
        compareMinutes >= windowStart && compareMinutes < windowEnd;


      if (isMatch) {
        const phone = normalizeIsraeliPhone(apt.phone);
        const toWhatsApp = phone.startsWith("whatsapp:")
          ? phone
          : phone.startsWith("+")
            ? `whatsapp:${phone}`
            : `whatsapp:+${phone}`;

        const name =
          `${apt.firstName || ""} ${apt.lastName || ""}`.trim() ||
          "عزيزي الزبون";

        if (dryRun) {
          debug.push({ to: toWhatsApp, name, time: apt.time });
          // Do NOT mark reminderSent in dryRun
          continue;
        }

        try {
          await sendWhatsAppTemplate({
            to: toWhatsApp,
            templateSid:
              process.env.TWILIO_TEMPLATE_APPOINTMENT_CUSTUMER_REMINDER,
            variables: {
              1: name,
              2: queryDate,
              3: apt.time,
            },
          });

          // Mark as sent ONLY after successful send
          await appointmentsCollection.updateOne(
            { date: queryDate, "appointments._id": apt._id },
            { $set: { "appointments.$.reminderSent": true } },
          );

          sent++;
        } catch (e) {
          failed++;
          errors.push({
            aptId: String(apt._id),
            to: toWhatsApp,
            message: e?.message || String(e),
          });
          console.error(
            "[cron-reminder][send] error to=%s err=%s",
            toWhatsApp,
            e?.message,
          );
        }
      }
    }

    return Response.json({
      success: true,
      date: queryDate,
      israelNow: `${israel.date} ${String(israel.hour).padStart(2, "0")}:${String(israel.minute).padStart(2, "0")}`,
      window: {
        from: minutesToTime(windowStart),
        to: minutesToTime(windowEnd),
      },
      sent,
      failed,
      ...(debug.length ? { debug } : {}),
      ...(errors.length ? { errors } : {}),
    });
  } catch (err) {
    console.error("Cron reminder error:", err);
    return Response.json(
      { error: "Failed", message: err?.message },
      { status: 500 },
    );
  }
}