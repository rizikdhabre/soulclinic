import { createHash } from "node:crypto";
import { getScheduleTimes, WORK_END, WORK_START } from "@/lib/appointmentRules";
import { getClinicNowParts, isValidClinicDate, isValidClinicTime } from "@/lib/clinicTime";

export class MonthlyScheduleError extends Error {
  constructor(code, message, status = 400) {
    super(message);
    this.name = "MonthlyScheduleError";
    this.code = code;
    this.status = status;
  }
}

const invalid = () => new MonthlyScheduleError("INVALID_SCHEDULE", "تحقق من الشهر والأيام والأوقات المحددة.");
const offeredTime = (time) => isValidClinicTime(time) && time >= WORK_START && time <= WORK_END;
const uniqueArray = (value, valid) => Array.isArray(value) && value.every(valid) && new Set(value).size === value.length;

export function normalizeMonthlyScheduleMonth(month) {
  if (typeof month !== "string" || !/^\d{4}-\d{2}$/.test(month) || !isValidClinicDate(`${month}-01`)) throw invalid();
  return month;
}

export function normalizeMonthlySchedule(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)
    || !Array.isArray(input.groups) || input.groups.length < 1 || input.groups.length > 7) throw invalid();
  const month = normalizeMonthlyScheduleMonth(input.month);
  const assigned = new Set();
  const groups = input.groups.map((group) => {
    if (!group || !uniqueArray(group.weekdays, (day) => Number.isInteger(day) && day >= 0 && day <= 6)
      || !group.weekdays.length || group.weekdays.some((day) => assigned.has(day))) throw invalid();
    group.weekdays.forEach((day) => assigned.add(day));
    const weekdays = [...group.weekdays].sort((a, b) => a - b);
    if (group.mode === "closed") {
      if (group.times !== undefined || group.blockedTimes !== undefined) throw invalid();
      return { weekdays, mode: "closed" };
    }
    if (group.mode !== "times" || !uniqueArray(group.times, offeredTime) || group.times.length < 1 || group.times.length > 40
      || !uniqueArray(group.blockedTimes, (time) => group.times.includes(time))) throw invalid();
    return { weekdays, mode: "times", times: [...group.times].sort(), blockedTimes: [...group.blockedTimes].sort() };
  });
  const excludedDates = input.excludedDates === undefined ? [] : input.excludedDates;
  if (!uniqueArray(excludedDates, (date) => isValidClinicDate(date) && date.startsWith(`${month}-`))) throw invalid();
  return { month, groups, excludedDates: [...excludedDates].sort() };
}

export function monthlyScheduleDates(month) {
  const dates = [];
  const cursor = new Date(`${month}-01T00:00:00.000Z`);
  while (cursor.toISOString().startsWith(`${month}-`)) {
    dates.push({ date: cursor.toISOString().slice(0, 10), weekday: cursor.getUTCDay() });
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return dates;
}

export function selectedMonthlyScheduleDates(intent) {
  return monthlyScheduleDates(intent.month).flatMap(({ date, weekday }) => {
    const groupIndex = intent.groups.findIndex((group) => group.weekdays.includes(weekday));
    return groupIndex === -1 ? [] : [{ date, groupIndex }];
  });
}

function canonical(value) {
  if (value?.toJSON) return canonical(value.toJSON());
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
  return value;
}

export function monthlyScheduleHash(value) {
  return createHash("sha256").update(JSON.stringify(canonical(value))).digest("hex");
}

function validDay(day) {
  return (day.editedTimes === undefined || uniqueArray(day.editedTimes, offeredTime))
    // Old blockers can contain valid clock starts outside the offered schedule.
    && (day.blockedTimes === undefined || uniqueArray(day.blockedTimes, isValidClinicTime))
    && (day.appointments === undefined || (Array.isArray(day.appointments)
      && day.appointments.every((appointment) => appointment && typeof appointment === "object" && isValidClinicTime(appointment.time))));
}

function groupDocumentsByDate(documents) {
  const byDate = new Map();
  for (const document of documents) {
    if (!byDate.has(document.date)) byDate.set(document.date, []);
    byDate.get(document.date).push(document);
  }
  return byDate;
}

function effectiveDay(records) {
  const day = records[0] || {};
  const validTimes = day.editedTimes === undefined || uniqueArray(day.editedTimes, offeredTime);
  const times = validTimes ? getScheduleTimes(day.editedTimes) : [];
  const blockedTimes = Array.isArray(day.blockedTimes) ? [...new Set(day.blockedTimes.filter(isValidClinicTime))].sort() : [];
  return {
    times, blockedTimes,
    valid: records.length <= 1 && validDay(day),
    customized: (Array.isArray(day.editedTimes) && day.editedTimes.length > 0) || blockedTimes.length > 0,
  };
}

export function buildMonthlyScheduleState(month, documents) {
  const byDate = groupDocumentsByDate(documents);
  return { month, days: monthlyScheduleDates(month).map(({ date, weekday }) => {
    const records = byDate.get(date) || [];
    const appointmentTimes = [...new Set(records.flatMap((day) => Array.isArray(day.appointments)
      ? day.appointments.map((appointment) => appointment?.time).filter(isValidClinicTime) : []))].sort();
    return { date, weekday, ...effectiveDay(records), appointmentTimes };
  }) };
}

export function buildMonthlySchedulePreview(intent, documents, now = new Date()) {
  const clinicDate = getClinicNowParts(now).date;
  const byDate = groupDocumentsByDate(documents);
  const state = [];
  const conflicts = [];
  const summary = { apply: 0, skipped: 0, existingAppointments: 0, affectedAppointments: 0 };
  const days = selectedMonthlyScheduleDates(intent).map(({ date, groupIndex }) => {
    const records = byDate.get(date) || [];
    const day = records[0] || {};
    state.push({ date, records: records.map((record) => ({ _id: record._id, editedTimes: record.editedTimes, blockedTimes: record.blockedTimes, appointments: record.appointments })) });
    const { valid, times: previousTimes, blockedTimes: previousBlockedTimes } = effectiveDay(records);
    const appointments = Array.isArray(day.appointments) ? day.appointments : [];
    const status = !valid ? "invalid" : date < clinicDate ? "past" : intent.excludedDates.includes(date) ? "excluded" : "apply";
    const group = intent.groups[groupIndex];
    const nextTimes = status !== "apply" || group.mode === "closed" ? [...previousTimes] : [...group.times];
    const nextBlockedTimes = status !== "apply" ? [...previousBlockedTimes] : group.mode === "closed"
      ? [...new Set([...previousTimes, ...previousBlockedTimes])].sort() : [...group.blockedTimes];
    const affectedAppointments = status === "apply"
      ? appointments.filter((appointment) => group.mode === "closed" || !nextTimes.includes(appointment.time) || nextBlockedTimes.includes(appointment.time)) : [];
    const affectedAppointmentCount = affectedAppointments.length;
    conflicts.push(...[...new Set(affectedAppointments.map((appointment) => appointment.time))].sort().map((time) => ({ date, time })));
    summary[status === "apply" ? "apply" : "skipped"] += 1;
    summary.existingAppointments += appointments.length;
    summary.affectedAppointments += affectedAppointmentCount;
    return { date, groupIndex, status, previousTimes, previousBlockedTimes, nextTimes, nextBlockedTimes, appointmentCount: appointments.length, affectedAppointmentCount };
  });
  return { previewToken: monthlyScheduleHash({ intent, clinicDate, state }), days, summary, conflicts, canApply: summary.apply > 0 && conflicts.length === 0 };
}
