import { createHash, randomBytes } from "node:crypto";
import { isIP } from "node:net";
import { ObjectId } from "mongodb";
import { normalizeIsraeliPhone } from "@/lib/phone";
import { getClinicNowParts, isValidClinicDate, isValidClinicTime } from "@/lib/clinicTime";

const COOLDOWN_MS = 30 * 24 * 60 * 60 * 1000;
const BATCH_SIZE = 50;
const DURABLE_WRITE = { writeConcern: { w: "majority", wtimeoutMS: 10_000 } };
const MAJORITY_READ = { readConcern: { level: "majority" } };

function appointmentKey(appointment) {
  return `${appointment.date} ${appointment.time}`;
}

function blocksReturnReminder(appointment, clinicNow) {
  // An unknown date could conceal a future appointment. Corrupt attended
  // history could conceal more recent care, so it cannot authorize a reminder.
  if (!appointment || !isValidClinicDate(appointment.date)) return true;
  if (!isValidClinicTime(appointment.time)) return appointment.attended === true || appointment.date >= clinicNow.date;
  return appointmentKey(appointment) >= appointmentKey(clinicNow);
}

function threeMonthsAfter(appointment) {
  const [year, month, day] = appointment.date.split("-").map(Number);
  const target = new Date(0);
  target.setUTCFullYear(year, month - 1 + 3, 1);
  const end = new Date(target);
  end.setUTCMonth(end.getUTCMonth() + 1, 0);
  target.setUTCDate(Math.min(day, end.getUTCDate()));
  return { date: target.toISOString().slice(0, 10), time: appointment.time };
}

/** Calendar arithmetic stays in Israel wall time; the monthly cooldown uses UTC elapsed time. */
export function getReturnReminderEligibility({ appointments, now = new Date() }) {
  if (!Array.isArray(appointments)) return { eligible: false };
  const clinicNow = getClinicNowParts(now);
  let lastAttended = null;
  for (const appointment of appointments) {
    if (blocksReturnReminder(appointment, clinicNow)) return { eligible: false };
    if (appointment.attended !== true || !isValidClinicTime(appointment.time)) continue;
    if (!lastAttended || appointmentKey(appointment) > appointmentKey(lastAttended)) lastAttended = appointment;
  }
  if (!lastAttended) return { eligible: false };
  const dueAt = threeMonthsAfter(lastAttended);
  return { eligible: appointmentKey(dueAt) <= appointmentKey(clinicNow), lastAttended, dueAt };
}

function publicOrigin(value) {
  if (typeof value !== "string" || !value.trim()) return null;
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash || url.pathname !== "/" ||
      !url.hostname.includes(".") || url.hostname.endsWith(".localhost") || url.hostname.endsWith(".local") ||
      isIP(url.hostname) || url.hostname.startsWith("[")) return null;
    return url.origin;
  } catch { return null; }
}

function phoneFilter(phone) {
  // Query all formats accepted by the shared normalizer, including legacy
  // punctuation and numeric storage. Confirm with that normalizer after reading.
  const national = phone.slice(4);
  const formats = [`0${national}`, `972${national}`, `00972${national}`];
  const pattern = `^[^0-9]*(?:${formats.map((digits) => digits.split("").join("[^0-9]*")).join("|")})[^0-9]*$`;
  return { $in: [new RegExp(pattern), Number(phone.slice(1))] };
}

async function resources(deps) {
  const getCollection = deps.getCollection || (await import("@/lib/db")).getCollection;
  const names = ["usersData", "appointments", "returnReminderPreferences", "returnReminderState", "returnReminderHistory"];
  const values = await Promise.all(names.map((name) => getCollection(name)));
  return { users: values[0], appointments: values[1], preferences: values[2], state: values[3], history: values[4] };
}

async function currentCustomer(phone, now, { users, appointments }) {
  const filter = phoneFilter(phone);
  const accounts = users.find({ phone: filter }, {
    ...MAJORITY_READ, projection: { phone: 1, firstName: 1, lastName: 1, appointments: 1 },
  }).batchSize(BATCH_SIZE);
  let latest = null;
  const clinicNow = getClinicNowParts(now);
  try {
    for await (const user of accounts) {
      if (normalizeIsraeliPhone(user.phone) !== phone) continue;
      if (!Array.isArray(user.appointments)) return null;
      const eligibility = getReturnReminderEligibility({ appointments: user.appointments, now });
      if (user.appointments.some((appointment) => blocksReturnReminder(appointment, clinicNow))) return null;
      if (eligibility.lastAttended && (!latest || appointmentKey(eligibility.lastAttended) > appointmentKey(latest.appointment))) {
        latest = { user, appointment: eligibility.lastAttended, eligible: eligibility.eligible };
      }
    }
  } finally { await accounts.close(); }
  if (!latest?.eligible || !latest.appointment._id) return null;

  // The calendar can contain a booking before the profile history write has
  // completed. Plan receipts are deliberately not used: they survive cancellation.
  const days = appointments.find({ "appointments.phone": filter }, {
    ...MAJORITY_READ, projection: { date: 1, "appointments.phone": 1, "appointments.time": 1 },
  }).batchSize(BATCH_SIZE);
  try {
    for await (const day of days) {
      if (!Array.isArray(day.appointments)) return null;
      for (const appointment of day.appointments) {
        if (normalizeIsraeliPhone(appointment?.phone) === phone && blocksReturnReminder({ date: day.date, time: appointment.time }, clinicNow)) return null;
      }
    }
  } finally { await days.close(); }
  return latest;
}

function sameAppointment(current, record) {
  return current && String(current.user._id) === String(record.userId) &&
    String(current.appointment._id) === String(record.lastAttended._id) &&
    current.appointment.date === record.lastAttended.date && current.appointment.time === record.lastAttended.time;
}

function singleLine(value, maxLength) {
  return typeof value === "string" ? value.replace(/\s+/gu, " ").trim().slice(0, maxLength) : "";
}

async function cancelAttempt(history, record, now) {
  await history.updateOne({ _id: record._id, "dispatch.status": "claimed" }, {
    $set: { "dispatch.status": "canceled", "dispatch.completedAt": now },
  }, DURABLE_WRITE);
}

export async function sendDueReturnReminders({ now = new Date(), dryRun = false } = {}, deps = {}) {
  const env = deps.env || process.env;
  const result = { status: "completed", dryRun: Boolean(dryRun), eligible: 0, sent: 0, failed: 0, unknown: 0, skipped: 0 };
  if (env.RETURN_REMINDERS_ENABLED !== "true") return { ...result, status: "disabled" };
  const baseUrl = publicOrigin(env.RETURN_REMINDERS_PUBLIC_BASE_URL);
  if (!baseUrl || !env.TWILIO_TEMPLATE_SOUL_RETURN?.trim() || !env.CRON_SECRET?.trim() ||
    !env.TWILIO_ACCOUNT_SID?.trim() || !env.TWILIO_AUTH_TOKEN?.trim() || !env.TWILIO_WHATSAPP_FROM?.trim()) {
    return { ...result, status: "not_configured" };
  }
  if (!(now instanceof Date) || !Number.isFinite(now.getTime())) throw new Error("Invalid return reminder time");
  // Advance the supplied logical time during slow batches/provider calls. Tests
  // inject a frozen clock, while normal runs do not reuse the batch-start instant.
  const clock = deps.clock || { now: () => new Date() };
  const startedAt = clock.now().getTime();
  const currentTime = () => new Date(now.getTime() + Math.max(0, clock.now().getTime() - startedAt));
  const data = await resources(deps);
  const { preferences, state, history } = data;
  const send = dryRun ? null : deps.sendWhatsAppTemplate || (await import("@/lib/whatsapp")).sendWhatsAppTemplate;
  if (!dryRun) {
    await history.createIndex({ tokenHash: 1 }, { name: "return_reminder_token_hash", unique: true,
      partialFilterExpression: { tokenHash: { $type: "string" } }, ...DURABLE_WRITE });
  }
  // Stream permissions, not a limited page of customers: cooled, malformed,
  // duplicate or ineligible records must never starve customers later in the run.
  const candidates = preferences.find({ enabled: true }, { ...MAJORITY_READ, projection: { _id: 1 } }).sort({ _id: 1 }).batchSize(BATCH_SIZE);
  let dispatched = 0;
  try {
    for await (const candidate of candidates) {
      if (dispatched >= BATCH_SIZE) break;
      const phone = normalizeIsraeliPhone(candidate._id);
      if (!phone || phone !== candidate._id) continue;
      const previous = await state.findOne({ _id: phone }, MAJORITY_READ);
      if (previous && (!(previous.nextAttemptAt instanceof Date) || previous.nextAttemptAt > currentTime())) continue;
      const owned = await currentCustomer(phone, currentTime(), data);
      if (!owned || (await preferences.findOne({ _id: phone }, MAJORITY_READ))?.enabled !== true) continue;
      result.eligible++;
      if (dryRun) continue;

      const claimedAt = currentTime();
      const token = randomBytes(32).toString("base64url");
      const record = {
        _id: new ObjectId(), phone, userId: owned.user._id, claimedAt,
        lastAttended: { _id: owned.appointment._id, date: owned.appointment.date, time: owned.appointment.time },
        tokenHash: createHash("sha256").update(token).digest("hex"), dispatch: { status: "claimed", claimedAt },
      };
      try {
        // For a new phone, upsert creates its unique _id. A competing or cooled
        // phone fails that unique key, so neither process can blindly retry.
        const claim = await state.findOneAndUpdate({ _id: phone, nextAttemptAt: { $lte: claimedAt } }, {
          $set: { attemptId: record._id, claimedAt, nextAttemptAt: new Date(claimedAt.getTime() + COOLDOWN_MS) },
          $setOnInsert: { createdAt: claimedAt },
        }, { upsert: true, returnDocument: "after", ...DURABLE_WRITE });
        if (!claim || String(claim.attemptId) !== String(record._id)) { result.skipped++; continue; }
      } catch (error) {
        if (error?.code !== 11000) throw error;
        result.skipped++;
        continue;
      }
      // If this fails, the phone claim still consumes the cooldown. Never send a
      // link whose persistent unsubscribe history could not be acknowledged.
      await history.insertOne(record, DURABLE_WRITE);
      const current = await currentCustomer(phone, currentTime(), data);
      if (!sameAppointment(current, record)) {
        await cancelAttempt(history, record, currentTime());
        result.skipped++;
        continue;
      }
      const dispatchAt = currentTime();
      // A suspended worker must not send after a newer monthly claim supersedes
      // it. Extend from dispatch time and never overwrite another claim identity.
      const dispatchClaim = await state.updateOne({ _id: phone, attemptId: record._id }, {
        $max: { nextAttemptAt: new Date(dispatchAt.getTime() + COOLDOWN_MS) },
        $set: { dispatchStartedAt: dispatchAt },
      }, DURABLE_WRITE);
      // Permission is the final database read immediately before provider dispatch.
      if (dispatchClaim.matchedCount !== 1 || (await preferences.findOne({ _id: phone }, MAJORITY_READ))?.enabled !== true) {
        await cancelAttempt(history, record, currentTime());
        result.skipped++;
        continue;
      }

      let outcome;
      dispatched++;
      try {
        const response = await send({
          to: `whatsapp:${phone}`, templateSid: env.TWILIO_TEMPLATE_SOUL_RETURN,
          variables: {
            1: singleLine(`${current.user.firstName || ""} ${current.user.lastName || ""}`, 80) || "عزيزي الزبون",
            2: current.appointment.date, 3: `${baseUrl}/dashboard`,
            4: `${baseUrl}/reminders/unsubscribe/${token}`,
          },
        });
        outcome = typeof response?.sid === "string" && response.sid ? { status: "sent", providerSid: response.sid } : { status: "unknown" };
      } catch (error) {
        const status = Number(error?.status);
        outcome = { status: status >= 400 && status < 500 && status !== 408 ? "failed" : "unknown" };
      }
      const completedAt = currentTime();
      try {
        await state.updateOne({ _id: phone, attemptId: record._id }, {
          $max: { nextAttemptAt: new Date(completedAt.getTime() + COOLDOWN_MS) },
        }, DURABLE_WRITE);
        const saved = await history.updateOne({ _id: record._id, "dispatch.status": "claimed" }, {
          $set: { dispatch: { ...record.dispatch, ...outcome, completedAt } },
        }, DURABLE_WRITE);
        if (saved.matchedCount !== 1) throw new Error("Return reminder result unavailable");
        result[outcome.status]++;
      } catch {
        // Never retain raw provider errors, bearer URLs or customer details in
        // summaries. A failed outcome write does not release the durable claim.
        result.unknown++;
      }
    }
  } finally { await candidates.close(); }
  return result;
}
