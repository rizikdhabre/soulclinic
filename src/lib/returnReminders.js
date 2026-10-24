import { createHash, randomBytes } from "node:crypto";
import { isIP } from "node:net";
import { ObjectId } from "mongodb";
import { normalizeIsraeliPhone } from "@/lib/phone";
import { getClinicNowParts, isValidClinicDate, isValidClinicTime } from "@/lib/clinicTime";
import { isReturnReminderEnabled } from "@/lib/returnReminderPreferences";
import { getReturnReminderSettings, normalizeReturnReminderSchedule } from "@/lib/returnReminderSettings";
import { getReminderInactivityDueAt, getReminderRepeatAt } from "@/lib/returnReminderSchedule";

const BATCH_SIZE = 50;
const DURABLE_WRITE = { writeConcern: { w: "majority", wtimeoutMS: 10_000 } };
const MAJORITY_READ = { readConcern: { level: "majority" }, maxTimeMS: 10_000 };

function checkBudget(shouldStop) {
  if (shouldStop?.()) throw Object.assign(new Error("Return reminder budget reached"), { code: "REMINDER_BUDGET_REACHED" });
}

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

/** Default first wait and custom intervals use Israel calendar arithmetic. */
export function getReturnReminderEligibility({ appointments, now = new Date(), schedule = { mode: "default" } }) {
  if (!Array.isArray(appointments)) return { eligible: false };
  try { schedule = normalizeReturnReminderSchedule(schedule); } catch { return { eligible: false }; }
  const clinicNow = getClinicNowParts(now);
  let lastAttended = null;
  for (const appointment of appointments) {
    if (blocksReturnReminder(appointment, clinicNow)) return { eligible: false };
    if (appointment.attended !== true || !isValidClinicTime(appointment.time)) continue;
    if (!lastAttended || appointmentKey(appointment) > appointmentKey(lastAttended)) lastAttended = appointment;
  }
  if (!lastAttended) return { eligible: false };
  const dueAt = getReminderInactivityDueAt(lastAttended, schedule);
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

export function phoneFilter(phone) {
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

async function currentCustomer(phone, now, { users, appointments }, schedule, shouldStop) {
  checkBudget(shouldStop);
  const filter = phoneFilter(phone);
  const accounts = users.find({ phone: filter }, {
    ...MAJORITY_READ, projection: { phone: 1, firstName: 1, lastName: 1, appointments: 1 },
  }).batchSize(BATCH_SIZE);
  let latest = null;
  const clinicNow = getClinicNowParts(now);
  try {
    for await (const user of accounts) {
      checkBudget(shouldStop);
      if (normalizeIsraeliPhone(user.phone) !== phone) continue;
      if (!Array.isArray(user.appointments)) return null;
      const eligibility = getReturnReminderEligibility({ appointments: user.appointments, now, schedule });
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
      checkBudget(shouldStop);
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

function configuredIntervalLabel(schedule) {
  // Display the saved inactivity interval, including on subsequent reminders.
  const { value, unit } = schedule.mode === "custom" ? schedule : { value: 3, unit: "months" };
  const days = unit === "days";
  if (value === 1) return days ? "يوم واحد" : "شهر واحد";
  if (value === 2) return days ? "يومين" : "شهرين";
  const plural = value >= 3 && value <= 10;
  return `${value} ${days ? (plural ? "أيام" : "يوم") : (plural ? "شهور" : "شهر")}`;
}

async function cancelAttempt(history, record, now) {
  await history.updateOne({ _id: record._id, "dispatch.status": "claimed" }, {
    $set: { "dispatch.status": "canceled", "dispatch.completedAt": now },
  }, DURABLE_WRITE);
}

// Null means no prior attempt; an invalid date keeps malformed state ineligible.
export async function getReturnReminderRepeatDueAt(previous, phone, schedule, history) {
  if (!previous) return null;
  if (!(previous.nextAttemptAt instanceof Date) || !Number.isFinite(previous.nextAttemptAt.getTime())) return new Date(NaN);
  const attempt = previous.attemptId ? await history.findOne({ _id: previous.attemptId, phone }, {
    ...MAJORITY_READ, projection: { dispatch: 1 },
  }) : null;
  const completedAt = attempt?.dispatch?.completedAt;
  if (["sent", "failed", "unknown", "canceled"].includes(attempt?.dispatch?.status) &&
    completedAt instanceof Date && Number.isFinite(completedAt.getTime())) {
    // The current rule governs completed attempts, including pre-custom history.
    // Keep a delayed dispatch/claim as a lower bound if old data is inconsistent.
    const anchors = [completedAt, previous.claimedAt, previous.dispatchStartedAt]
      .filter(value => value instanceof Date && Number.isFinite(value.getTime()));
    return getReminderRepeatAt(new Date(Math.max(...anchors.map(value => value.getTime()))), schedule);
  }
  // An unresolved send or legacy state without history keeps its reservation;
  // shortening a schedule must not release an ambiguous provider request early.
  return previous.nextAttemptAt;
}

async function currentSettings(phone, deps) {
  try { return await getReturnReminderSettings({ phone }, deps); }
  catch (error) {
    if (error.code === "RETURN_REMINDER_SETTINGS_INVALID") return null;
    throw error;
  }
}

export async function sendDueReturnReminders({ now = new Date(), dryRun = false, afterId = null, throughId = null, scanProgress = false } = {}, deps = {}) {
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
  const { users, preferences, state, history } = data;
  const send = dryRun ? null : deps.sendWhatsAppTemplate || (await import("@/lib/whatsapp")).sendWhatsAppTemplate;
  if (!dryRun) {
    await history.createIndex({ tokenHash: 1 }, { name: "return_reminder_token_hash", unique: true,
      partialFilterExpression: { tokenHash: { $type: "string" } }, ...DURABLE_WRITE });
  }
  // Missing preference rows are enabled by policy. Stream all customers and
  // deduplicate normalized phones; skipped early rows must not starve later ones.
  if (afterId !== null && (typeof afterId !== "string" || !/^[a-f\d]{24}$/i.test(afterId))) throw new Error("Invalid scan cursor");
  if (throughId !== null && (typeof throughId !== "string" || !/^[a-f\d]{24}$/i.test(throughId))) throw new Error("Invalid scan boundary");
  const idRange = { ...(afterId ? { $gt: new ObjectId(afterId) } : {}), ...(throughId ? { $lte: new ObjectId(throughId) } : {}) };
  const candidates = users.find(afterId || throughId ? { _id: idRange } : {}, {
    ...MAJORITY_READ, projection: { phone: 1 },
  }).sort({ _id: 1 }).batchSize(BATCH_SIZE);
  const seenPhones = deps.seenPhones || new Set();
  let dispatched = 0;
  let scanned = 0;
  let cursor = afterId;
  let resumeCursor = cursor;
  let pendingRecord = null;
  let hasMore = false;
  try {
    for await (const candidate of candidates) {
      if (dispatched >= BATCH_SIZE || scanProgress && (scanned >= 500 || deps.shouldStop?.())) { hasMore = true; break; }
      scanned++;
      resumeCursor = cursor;
      cursor = String(candidate._id);
      pendingRecord = null;
      if (typeof candidate.phone !== "string" && typeof candidate.phone !== "number") continue;
      const phone = normalizeIsraeliPhone(candidate.phone);
      if (!phone || seenPhones.has(phone)) continue;
      seenPhones.add(phone);
      const settings = await currentSettings(phone, deps);
      checkBudget(deps.shouldStop);
      if (!settings) { result.skipped++; continue; }
      const previous = await state.findOne({ _id: phone }, MAJORITY_READ);
      const repeatDueAt = await getReturnReminderRepeatDueAt(previous, phone, settings.schedule, history);
      if (repeatDueAt && !(repeatDueAt <= currentTime())) continue;
      const owned = await currentCustomer(phone, currentTime(), data, settings.schedule, deps.shouldStop);
      if (!owned || !isReturnReminderEnabled(await preferences.findOne({ _id: phone }, MAJORITY_READ))) continue;
      checkBudget(deps.shouldStop);
      result.eligible++;
      if (dryRun) continue;

      const claimedAt = currentTime();
      const token = randomBytes(32).toString("base64url");
      const record = {
        _id: new ObjectId(), phone, userId: owned.user._id, claimedAt,
        schedule: settings.schedule, scheduleRevision: settings.scheduleRevision,
        lastAttended: { _id: owned.appointment._id, date: owned.appointment.date, time: owned.appointment.time },
        tokenHash: createHash("sha256").update(token).digest("hex"), dispatch: { status: "claimed", claimedAt },
      };
      try {
        // For a new phone, upsert creates its unique _id. A competing or cooled
        // phone fails that unique key, so neither process can blindly retry.
        const snapshot = previous ? {
          nextAttemptAt: previous.nextAttemptAt,
          attemptId: previous.attemptId ?? { $exists: false },
        } : { nextAttemptAt: { $exists: false }, attemptId: { $exists: false } };
        const claim = await state.findOneAndUpdate({ _id: phone, ...snapshot }, {
          $set: { attemptId: record._id, claimedAt, nextAttemptAt: getReminderRepeatAt(claimedAt, settings.schedule) },
          $unset: { dispatchStartedAt: "" },
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
      pendingRecord = record;
      const current = await currentCustomer(phone, currentTime(), data, settings.schedule, deps.shouldStop);
      if (!sameAppointment(current, record)) {
        await cancelAttempt(history, record, currentTime());
        result.skipped++;
        continue;
      }
      const dispatchAt = currentTime();
      // A suspended worker must not send after a newer reminder claim supersedes
      // it. Extend from dispatch time and never overwrite another claim identity.
      const dispatchClaim = await state.updateOne({ _id: phone, attemptId: record._id }, {
        $max: { nextAttemptAt: getReminderRepeatAt(dispatchAt, settings.schedule) },
        $set: { dispatchStartedAt: dispatchAt },
      }, DURABLE_WRITE);
      const dispatchSettings = await currentSettings(phone, deps);
      // Rule version and permission are read immediately before provider dispatch.
      if (dispatchClaim.matchedCount !== 1 || dispatchSettings?.scheduleRevision !== settings.scheduleRevision ||
        !isReturnReminderEnabled(await preferences.findOne({ _id: phone }, MAJORITY_READ))) {
        await cancelAttempt(history, record, currentTime());
        result.skipped++;
        continue;
      }

      checkBudget(deps.shouldStop);

      let outcome;
      dispatched++;
      try {
        const response = await send({
          to: `whatsapp:${phone}`, templateSid: env.TWILIO_TEMPLATE_SOUL_RETURN,
          variables: {
            1: singleLine(`${current.user.firstName || ""} ${current.user.lastName || ""}`, 80) || "عزيزي الزبون",
            2: configuredIntervalLabel(settings.schedule),
            3: current.appointment.date, 4: `${baseUrl}/dashboard`,
            // The approved CTA owns the fixed /reminders/unsubscribe/ URL prefix.
            5: token,
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
          $max: { nextAttemptAt: getReminderRepeatAt(completedAt, settings.schedule) },
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
  } catch (error) {
    if (error.code !== "REMINDER_BUDGET_REACHED") throw error;
    hasMore = true;
    if (pendingRecord) {
      await cancelAttempt(history, pendingRecord, currentTime());
      result.skipped++;
    } else cursor = resumeCursor;
  } finally { await candidates.close(); }
  if (scanProgress) result.scan = { hasMore, cursor, scanned };
  return result;
}
