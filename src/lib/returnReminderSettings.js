import { normalizeIsraeliPhone } from "@/lib/phone";

const projection = { schedule: 1, scheduleRevision: 1 };
const writeConcern = { w: "majority", j: true, wtimeoutMS: 10_000 };
const failure = (status, code) => Object.assign(new Error(code), { status, code });
const validRevision = value => Number.isSafeInteger(value) && value >= 0;

export function normalizeReturnReminderSchedule(schedule) {
  if (!schedule || typeof schedule !== "object" || Array.isArray(schedule)) throw failure(400, "INVALID_RETURN_REMINDER_SCHEDULE");
  const keys = Object.keys(schedule);
  if (schedule.mode === "default" && keys.length === 1 && keys[0] === "mode") return { mode: "default" };
  if (schedule.mode !== "custom" || keys.length !== 3 || !keys.every(key => ["mode", "value", "unit"].includes(key))
    || !Number.isSafeInteger(schedule.value) || schedule.value < 1
    || !["days", "months"].includes(schedule.unit) || schedule.value > (schedule.unit === "days" ? 3650 : 120)) {
    throw failure(400, "INVALID_RETURN_REMINDER_SCHEDULE");
  }
  return { mode: "custom", value: schedule.value, unit: schedule.unit };
}

function phoneKey(phone) {
  const normalized = typeof phone === "string" ? normalizeIsraeliPhone(phone) : null;
  if (!normalized) throw failure(400, "INVALID_PHONE");
  return normalized;
}

async function collection(deps) {
  if (deps.db) return deps.db.collection("returnReminderSettings");
  const getCollection = deps.getCollection || (await import("@/lib/db")).getCollection;
  return getCollection("returnReminderSettings");
}

function projectSettings(record) {
  if (!record || (!Object.hasOwn(record, "schedule") && (!Object.hasOwn(record, "scheduleRevision") || record.scheduleRevision === 0))) {
    return { schedule: { mode: "default" }, scheduleRevision: 0 };
  }
  try {
    if (!validRevision(record.scheduleRevision)) throw new Error("Invalid stored revision");
    return { schedule: normalizeReturnReminderSchedule(record.schedule), scheduleRevision: record.scheduleRevision };
  } catch {
    // A corrupt stored rule must never turn into permission to send on default timing.
    throw failure(500, "RETURN_REMINDER_SETTINGS_INVALID");
  }
}

export async function getReturnReminderSettings({ phone }, deps = {}) {
  const key = phoneKey(phone);
  const settings = await collection(deps);
  return projectSettings(await settings.findOne({ _id: key }, { projection, readConcern: { level: "majority" }, maxTimeMS: 10_000 }));
}

export async function setReturnReminderSettings({ phone, schedule, scheduleRevision, adminId }, deps = {}) {
  const key = phoneKey(phone);
  const normalizedSchedule = normalizeReturnReminderSchedule(schedule);
  if (!validRevision(scheduleRevision) || scheduleRevision === Number.MAX_SAFE_INTEGER) throw failure(400, "INVALID_SCHEDULE_REVISION");
  const now = typeof deps.now === "function" ? deps.now() : deps.now ?? new Date();
  if (!(now instanceof Date) || !Number.isFinite(now.getTime())) throw failure(500, "RETURN_REMINDER_SETTINGS_INVALID");
  const settings = await collection(deps);
  const filter = scheduleRevision === 0
    ? { _id: key, $or: [{ scheduleRevision: 0 }, { scheduleRevision: { $exists: false } }] }
    : { _id: key, scheduleRevision };
  let updated;
  try {
    updated = await settings.findOneAndUpdate(filter, {
      $set: { schedule: normalizedSchedule, scheduleRevision: scheduleRevision + 1, scheduleUpdatedAt: now, scheduleUpdatedByAdminId: adminId == null ? null : String(adminId) },
      $setOnInsert: { createdAt: now },
    }, { upsert: scheduleRevision === 0, returnDocument: "after", projection, writeConcern });
  } catch (error) {
    // The unique normalized phone also protects competing first saves.
    if (error?.code !== 11000) throw error;
    throw failure(409, "RETURN_REMINDER_SETTINGS_CONFLICT");
  }
  if (!updated) throw failure(409, "RETURN_REMINDER_SETTINGS_CONFLICT");
  return projectSettings(updated);
}
