import { normalizeIsraeliPhone } from "@/lib/phone";
import { getClinicNowParts, isValidClinicDate, isValidClinicTime } from "@/lib/clinicTime";
import { isReturnReminderEnabled } from "@/lib/returnReminderPreferences";
import { getReturnReminderSettings } from "@/lib/returnReminderSettings";
import { getReturnReminderRepeatDueAt, phoneFilter } from "@/lib/returnReminders";
import { addReminderCalendarInterval, getReminderClinicInstant, getReminderInactivityDueAt } from "@/lib/returnReminderSchedule";

const readOptions = { readConcern: { level: "majority" }, maxTimeMS: 10_000 };
const failure = (status, code) => Object.assign(new Error(code), { status, code });
const validDate = value => value instanceof Date && Number.isFinite(value.getTime());
const key = appointment => `${appointment.date} ${appointment.time}`;

function classifyAppointment(appointment, clinicNow) {
  if (!appointment || !isValidClinicDate(appointment.date)) return "unavailable";
  if (!isValidClinicTime(appointment.time)) {
    return appointment.attended === true || appointment.date >= clinicNow.date ? "unavailable" : "past";
  }
  if (key(appointment) >= key(clinicNow)) return appointment.attended === true ? "unavailable" : "upcoming";
  return appointment.attended === true && !appointment._id ? "unavailable" : "past";
}

async function attendanceStatus(phone, now, users, calendar) {
  const filter = phoneFilter(phone);
  const clinicNow = getClinicNowParts(now);
  let lastAttended = null, upcoming = false, unavailable = false;
  const profiles = users.find({ phone: filter }, { ...readOptions, projection: { phone: 1, appointments: 1 } }).batchSize(50);
  try {
    for await (const user of profiles) {
      if (normalizeIsraeliPhone(user.phone) !== phone) continue;
      if (!Array.isArray(user.appointments)) { unavailable = true; continue; }
      for (const appointment of user.appointments) {
        const state = classifyAppointment(appointment, clinicNow);
        if (state === "unavailable") unavailable = true;
        else if (state === "upcoming") upcoming = true;
        else if (appointment.attended === true && (!lastAttended || key(appointment) > key(lastAttended))) {
          lastAttended = { date: appointment.date, time: appointment.time };
        }
      }
    }
  } finally { await profiles.close(); }

  // Calendar writes can precede profile history writes, so both stores pause estimates.
  const days = calendar.find({ "appointments.phone": filter }, {
    ...readOptions, projection: { date: 1, "appointments.phone": 1, "appointments.time": 1 },
  }).batchSize(50);
  try {
    for await (const day of days) {
      if (!Array.isArray(day.appointments)) { unavailable = true; continue; }
      for (const appointment of day.appointments) {
        if (normalizeIsraeliPhone(appointment?.phone) !== phone) continue;
        const state = classifyAppointment({ date: day.date, time: appointment.time }, clinicNow);
        if (state === "unavailable") unavailable = true;
        else if (state === "upcoming") upcoming = true;
      }
    }
  } finally { await days.close(); }
  return { lastAttended: unavailable ? null : lastAttended, upcoming, unavailable };
}

function dailyOpportunity(at) {
  let parts = { date: getClinicNowParts(at).date, time: "19:00" };
  let instant = getReminderClinicInstant(parts);
  if (instant < at) {
    parts = addReminderCalendarInterval(parts, 1, "days");
    instant = getReminderClinicInstant(parts);
  }
  return instant;
}

export async function getReturnReminderStatus({ phone, now = new Date() }, deps = {}) {
  const normalized = typeof phone === "string" ? normalizeIsraeliPhone(phone) : null;
  if (!normalized) throw failure(400, "INVALID_PHONE");
  if (!validDate(now)) throw failure(500, "RETURN_REMINDER_STATUS_UNAVAILABLE");
  const getCollection = deps.getCollection || (deps.db ? name => deps.db.collection(name) : (await import("@/lib/db")).getCollection);
  const [users, calendar, preferences, state, history] = await Promise.all(
    ["usersData", "appointments", "returnReminderPreferences", "returnReminderState", "returnReminderHistory"].map(name => getCollection(name)),
  );
  const [attendance, preference, previous] = await Promise.all([
    attendanceStatus(normalized, now, users, calendar),
    preferences.findOne({ _id: normalized }, { ...readOptions, projection: { enabled: 1, source: 1, updatedAt: 1, disabledAt: 1, policyRevision: 1 } }),
    state.findOne({ _id: normalized }, { ...readOptions, projection: { claimedAt: 1, dispatchStartedAt: 1, nextAttemptAt: 1, attemptId: 1 } }),
  ]);
  const anchors = ["claimedAt", "dispatchStartedAt"].filter(field => previous && Object.hasOwn(previous, field)).map(field => previous[field]);
  const invalidAttempt = anchors.some(value => !validDate(value) || value > now);
  const lastAttempt = previous?.dispatchStartedAt ?? previous?.claimedAt;
  const result = {
    lastAttended: attendance.lastAttended,
    lastAttemptAt: !invalidAttempt && validDate(lastAttempt) ? lastAttempt.toISOString() : null,
    nextReminderAt: null,
    status: "unavailable",
  };
  if (!isReturnReminderEnabled(preference)) return { ...result, status: "disabled" };
  if (attendance.unavailable || invalidAttempt) return result;

  let settings;
  try { settings = await getReturnReminderSettings({ phone: normalized }, deps); }
  catch (error) {
    if (error.code === "RETURN_REMINDER_SETTINGS_INVALID") return result;
    throw error;
  }
  // Invalid completion metadata cannot justify a promised next run. The sender's
  // shared helper still owns the repeat arithmetic and unresolved reservation rule.
  if (previous?.attemptId) {
    const attempt = await history.findOne({ _id: previous.attemptId, phone: normalized }, { ...readOptions, projection: { dispatch: 1 } });
    const dispatch = attempt?.dispatch;
    if (attempt && !["claimed", "sent", "failed", "unknown", "canceled"].includes(dispatch?.status)) return result;
    const completed = ["sent", "failed", "unknown", "canceled"].includes(dispatch?.status);
    if ((completed || dispatch && Object.hasOwn(dispatch, "completedAt")) && (!validDate(dispatch.completedAt) || dispatch.completedAt > now)) return result;
    if (dispatch && Object.hasOwn(dispatch, "claimedAt") && (!validDate(dispatch.claimedAt) || dispatch.claimedAt > now)) return result;
  }
  const repeatDue = await getReturnReminderRepeatDueAt(previous, normalized, settings.schedule, history);
  if (repeatDue !== null && !validDate(repeatDue)) return result;
  if (attendance.upcoming) return { ...result, status: "upcoming" };
  if (!attendance.lastAttended) return { ...result, status: "no_attendance" };
  const inactivityDue = getReminderClinicInstant(getReminderInactivityDueAt(attendance.lastAttended, settings.schedule));
  const readyAt = new Date(Math.max(now.getTime(), inactivityDue.getTime(), repeatDue?.getTime() ?? 0));
  const next = dailyOpportunity(readyAt);
  return { ...result, nextReminderAt: next.toISOString(), status: "scheduled" };
}
