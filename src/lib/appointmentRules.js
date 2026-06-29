export const SLOT_MINUTES = 30;
export const WORK_START = "10:00";
export const WORK_END = "19:30";

export class TimeSlotUnavailableError extends Error {
  constructor(message = "This time slot was just booked. Please choose another time.") {
    super(message);
    this.name = "TimeSlotUnavailableError";
    this.code = "TIME_SLOT_UNAVAILABLE";
    this.status = 409;
  }
}

export function toMinutes(time) {
  const [h, m] = String(time || "")
    .split(":")
    .map(Number);

  if (!Number.isFinite(h) || !Number.isFinite(m)) return null;
  return h * 60 + m;
}

export function getDurationMinutes(duration) {
  const n = Number(duration);
  return Number.isFinite(n) && n > 0 ? n : SLOT_MINUTES;
}

export function getSafeNumber(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

export function rangesOverlap(startA, endA, startB, endB) {
  return startA < endB && endA > startB;
}

export function buildDefaultSlots() {
  const slots = [];
  const workEnd = toMinutes(WORK_END);

  for (let h = 10; h < 20; h++) {
    for (let m = 0; m < 60; m += SLOT_MINUTES) {
      const time = `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
      const minutes = toMinutes(time);
      if (minutes !== null && minutes <= workEnd) slots.push(time);
    }
  }

  return slots;
}

export const DEFAULT_SLOTS = buildDefaultSlots();

export function getScheduleTimes(editedTimes) {
  const workStart = toMinutes(WORK_START);
  const workEnd = toMinutes(WORK_END);
  const sourceTimes =
    Array.isArray(editedTimes) && editedTimes.length > 0
      ? editedTimes
      : DEFAULT_SLOTS;

  return sourceTimes
    .filter((time) => {
      const minutes = toMinutes(time);
      return minutes !== null && minutes >= workStart && minutes <= workEnd;
    })
    .sort((a, b) => toMinutes(a) - toMinutes(b));
}

export function isTimeSlotAvailable({
  day,
  time,
  duration,
  ignoreAppointmentId,
}) {
  const sourceTimes = getScheduleTimes(day?.editedTimes);
  const blockedTimes = Array.isArray(day?.blockedTimes) ? day.blockedTimes : [];
  const appointments = Array.isArray(day?.appointments) ? day.appointments : [];
  const start = toMinutes(time);
  const workEnd = toMinutes(WORK_END);
  const ignoredId = ignoreAppointmentId ? String(ignoreAppointmentId) : null;

  if (start === null) return false;

  const safeDuration = getDurationMinutes(duration);
  const end = start + safeDuration;

  if (!sourceTimes.includes(time)) return false;
  if (end > workEnd) return false;
  if (blockedTimes.includes(time)) return false;

  return !appointments.some((apt) => {
    if (ignoredId && String(apt?._id) === ignoredId) return false;

    const aptStart = toMinutes(apt?.time);
    if (aptStart === null) return false;

    const aptDuration = getDurationMinutes(apt?.duration);
    const aptEnd = aptStart + aptDuration;

    return rangesOverlap(start, end, aptStart, aptEnd);
  });
}
