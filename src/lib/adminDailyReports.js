import { createHash, randomUUID } from "node:crypto";
import { getClinicNowParts } from "@/lib/clinicTime";
import { getReminderClinicInstant } from "@/lib/returnReminderSchedule";
import { normalizeIsraeliPhone } from "@/lib/phone";
import { loadTomorrowAppointments, loadUnreportedFeedback } from "@/lib/adminDailyReportData";
import { buildAdminReportText } from "@/lib/adminDailyReportText";

const WRITE = { writeConcern: { w: "majority", wtimeoutMS: 10_000 } };
const TRANSACTION = { readConcern: { level: "snapshot" }, writeConcern: WRITE.writeConcern, maxCommitTimeMS: 10_000 };
const TYPES = ["appointments", "feedback"];

function calendarDay(date, offset) {
  const day = new Date(`${date}T12:00:00Z`);
  day.setUTCDate(day.getUTCDate() + offset);
  return day.toISOString().slice(0, 10);
}

function config(env) {
  const keys = ["TWILIO_TEMPLATE_TOMORROW_APPOINTMENTS", "TWILIO_TEMPLATE_FEEDBACK", "TWILIO_WHATSAPP_TO",
    "TWILIO_WHATSAPP_FROM", "TWILIO_ACCOUNT_SID", "TWILIO_AUTH_TOKEN", "CRON_SECRET"];
  if (keys.some(key => typeof env[key] !== "string" || !env[key].trim())) return null;
  const phone = normalizeIsraeliPhone(env.TWILIO_WHATSAPP_TO);
  if (!phone) return null;
  return { to: `whatsapp:${phone}`, templates: {
    appointments: env.TWILIO_TEMPLATE_TOMORROW_APPOINTMENTS.trim(), feedback: env.TWILIO_TEMPLATE_FEEDBACK.trim(),
  } };
}

const summary = (status, report = {}) => ({ status, count: report.count || 0, characters: report.characters || 0 });
const previousSummary = report => summary(report.status === "sent" ? "already_sent" : report.status, report);

async function feedbackBaseline({ date, now, dryRun }, getCollection) {
  const state = await getCollection("adminDailyReportState");
  const from = getReminderClinicInstant({ date: calendarDay(date, -1), time: "21:00" });
  if (dryRun) return (await state.findOne({ _id: "feedback" }))?.from || from;
  try {
    const record = await state.findOneAndUpdate({ _id: "feedback" }, {
      $setOnInsert: { from, createdAt: now },
    }, { upsert: true, returnDocument: "after", ...WRITE });
    return record.from;
  } catch (error) {
    if (error.code !== 11000) throw error;
    return (await state.findOne({ _id: "feedback" })).from;
  }
}

async function prepare(type, context, deps, session) {
  const rows = type === "appointments"
    ? await loadTomorrowAppointments({ date: context.tomorrow }, { ...deps, session })
    : await loadUnreportedFeedback({ from: context.from, through: context.through }, { ...deps, session });
  const formatted = buildAdminReportText(type, rows);
  return { ...formatted, feedbackIds: type === "feedback" ? rows.map(row => row.id) : [] };
}

async function claimReport(type, context, deps) {
  const reports = await deps.getCollection("adminDailyReports");
  const claims = await deps.getCollection("adminDailyReportFeedback");
  const reportId = `${type}:${context.date}`;
  const session = deps.client.startSession();
  try {
    return await session.withTransaction(async () => {
      const previous = await reports.findOne({ _id: reportId }, { session });
      // A crashed/ambiguous send is deliberately not retried. Explicit provider
      // rejection is the only send outcome that permits another attempt.
      if (previous && previous.status !== "failed") return { existing: previousSummary(previous) };
      const prepared = await prepare(type, context, deps, session);
      if (!prepared.fits) return { existing: summary("too_long", prepared) };
      const payload = { to: context.settings.to, templateSid: context.settings.templates[type], variables: { 1: prepared.text } };
      const record = {
        type, date: context.date, targetDate: type === "appointments" ? context.tomorrow : context.date,
        cutoffAt: context.through, createdAt: previous?.createdAt || context.now, claimedAt: context.now,
        claimId: randomUUID(), status: "claimed", attempts: (previous?.attempts || 0) + 1,
        count: prepared.count, characters: prepared.characters, templateSid: payload.templateSid,
        payloadHash: createHash("sha256").update(JSON.stringify(payload)).digest("hex"),
      };
      if (previous) {
        await reports.updateOne({ _id: reportId, status: "failed" }, {
          $set: record, $unset: { completedAt: "", providerSid: "" },
        }, { session });
      } else {
        await reports.insertOne({ _id: reportId, ...record }, { session });
      }
      if (prepared.feedbackIds.length) {
        await claims.insertMany(prepared.feedbackIds.map(_id => ({ _id, reportId, claimId: record.claimId, claimedAt: context.now })), { session });
      }
      return { record: { _id: reportId, ...record }, payload };
    }, TRANSACTION);
  } catch (error) {
    if (error.code !== 11000) throw error;
    const existing = await reports.findOne({ _id: reportId });
    return { existing: existing ? previousSummary(existing) : summary("busy") };
  } finally {
    await session.endSession();
  }
}

async function saveOutcome(record, outcome, deps) {
  const reports = await deps.getCollection("adminDailyReports");
  const claims = await deps.getCollection("adminDailyReportFeedback");
  const session = deps.client.startSession();
  try {
    await session.withTransaction(async () => {
      const saved = await reports.updateOne({ _id: record._id, claimId: record.claimId, status: "claimed" }, {
        $set: { ...outcome, completedAt: new Date() },
      }, { session });
      if (saved.matchedCount !== 1) throw new Error("Report claim changed");
      // Release only a definite rejection, atomically with its failed status.
      // Unknown outcomes keep feedback reserved, even across later report days.
      if (outcome.status === "failed") {
        await claims.deleteMany({ reportId: record._id, claimId: record.claimId }, { session });
      }
    }, TRANSACTION);
  } finally {
    await session.endSession();
  }
}

async function dispatch(type, context, deps) {
  if (context.dryRun) {
    const prepared = await prepare(type, context, deps);
    return summary(prepared.fits ? "ready" : "too_long", prepared);
  }
  const claimed = await claimReport(type, context, deps);
  if (claimed.existing) return claimed.existing;
  let outcome;
  try {
    const result = await deps.sendWhatsAppTemplate(claimed.payload);
    // A Message SID confirms provider acceptance, not delivery to the admin.
    outcome = typeof result?.sid === "string" && result.sid
      ? { status: "sent", providerSid: result.sid } : { status: "unknown" };
  } catch (error) {
    const status = Number(error?.status);
    outcome = { status: status >= 400 && status < 500 && status !== 408 ? "failed" : "unknown" };
  }
  try {
    await saveOutcome(claimed.record, outcome, deps);
    return summary(outcome.status, claimed.record);
  } catch {
    // The durable claimed record survives a failed status write; never send again
    // just because recording the provider acknowledgement did not succeed.
    return summary("unknown", claimed.record);
  }
}

/** At most one accepted message per report/date, plus durable per-feedback claims. */
export async function runDailyAdminReports({ now = new Date(), dryRun = false } = {}, deps = {}) {
  const clinic = getClinicNowParts(now);
  const context = { now, dryRun: Boolean(dryRun), date: clinic.date, tomorrow: calendarDay(clinic.date, 1) };
  const result = { status: "completed", dryRun: context.dryRun, date: context.date, tomorrow: context.tomorrow };
  const settings = config(deps.env || process.env);
  const inactive = !settings ? "not_configured" : !dryRun && clinic.time < "21:00" ? "not_due" : null;
  if (inactive) return { ...result, status: inactive, appointments: summary(inactive), feedback: summary(inactive) };
  const getCollection = deps.getCollection || (await import("@/lib/db")).getCollection;
  const dependencies = { ...deps, getCollection };
  if (!dryRun) {
    dependencies.client = deps.client || await (await import("@/lib/db")).getMongoClient();
    dependencies.sendWhatsAppTemplate = deps.sendWhatsAppTemplate || (await import("@/lib/whatsapp")).sendWhatsAppTemplate;
    const feedback = await getCollection("appointmentFeedback");
    const claims = await getCollection("adminDailyReportFeedback");
    const reports = await getCollection("adminDailyReports");
    await feedback.createIndex({ "feedback.submittedAt": 1, _id: 1 }, { name: "admin_feedback_submitted", ...WRITE });
    await claims.createIndex({ reportId: 1, claimId: 1 }, { name: "admin_feedback_report", ...WRITE });
    await reports.createIndex({ date: -1, type: 1 }, { name: "admin_report_date", ...WRITE });
  }
  context.settings = settings;
  context.from = await feedbackBaseline(context, getCollection);
  context.through = getReminderClinicInstant({ date: context.date, time: "21:00" });
  for (const type of TYPES) {
    try {
      result[type] = await dispatch(type, context, dependencies);
    } catch {
      result[type] = summary("error");
    }
  }
  if (TYPES.some(type => !["sent", "already_sent", "ready"].includes(result[type].status))) result.status = "partial";
  return result;
}
