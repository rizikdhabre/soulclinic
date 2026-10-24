import { getClinicNowParts } from "@/lib/clinicTime";

const DAY_MS = 24 * 60 * 60 * 1000;

/** Calendar intervals retain clinic wall time and clamp the end of a month. */
export function addReminderCalendarInterval({ date, time }, value, unit) {
  const [year, month, day] = date.split("-").map(Number);
  const target = new Date(`${date}T00:00:00Z`);
  if (unit === "days") target.setUTCDate(day + value);
  else {
    target.setUTCFullYear(year, month - 1 + value, 1);
    const end = new Date(target);
    end.setUTCMonth(end.getUTCMonth() + 1, 0);
    target.setUTCDate(Math.min(day, end.getUTCDate()));
  }
  return { date: target.toISOString().slice(0, 10), time };
}

export function getReminderInactivityDueAt(appointment, schedule) {
  return schedule.mode === "custom"
    ? addReminderCalendarInterval(appointment, schedule.value, schedule.unit)
    : addReminderCalendarInterval(appointment, 3, "months");
}

function wallMilliseconds(parts) {
  return Date.parse(`${parts.date}T${parts.time}:00Z`);
}

/** Resolve clinic wall time using Intl's timezone data, including DST boundaries. */
export function getReminderClinicInstant(parts, millisecondsWithinMinute = 0) {
  const wall = wallMilliseconds(parts);
  const offsets = new Set();
  for (const hours of [-36, 0, 36]) {
    const instant = wall + hours * 60 * 60 * 1000;
    offsets.add(wallMilliseconds(getClinicNowParts(new Date(instant))) - instant);
  }
  const candidates = [...offsets].map(offset => new Date(wall - offset + millisecondsWithinMinute));
  const exact = candidates.filter(value => wallMilliseconds(getClinicNowParts(value)) === wall);
  // Repeated autumn times use the later occurrence. A nonexistent spring time
  // moves forward across the gap, never before the intended local time.
  if (exact.length) return new Date(Math.max(...exact.map(value => value.getTime())));
  return candidates.filter(value => wallMilliseconds(getClinicNowParts(value)) > wall)
    .sort((left, right) => left - right)[0];
}

export function getReminderRepeatAt(anchor, schedule) {
  if (schedule.mode === "default") return new Date(anchor.getTime() + 30 * DAY_MS);
  const parts = addReminderCalendarInterval(getClinicNowParts(anchor), schedule.value, schedule.unit);
  return getReminderClinicInstant(parts, anchor.getUTCSeconds() * 1000 + anchor.getUTCMilliseconds());
}
