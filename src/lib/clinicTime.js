const clinicClock = new Intl.DateTimeFormat("en-CA", {
  timeZone: "Asia/Jerusalem",
  year: "numeric", month: "2-digit", day: "2-digit",
  hour: "2-digit", minute: "2-digit", hourCycle: "h23",
});

export function getClinicNowParts(now = new Date()) {
  const parts = Object.fromEntries(clinicClock.formatToParts(now).map(({ type, value }) => [type, value]));
  return { date: `${parts.year}-${parts.month}-${parts.day}`, time: `${parts.hour}:${parts.minute}` };
}

export function isValidClinicDate(value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

export function isValidClinicTime(value) {
  return typeof value === "string" && /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(value);
}

export function compareAppointmentToNow({ date, time }, now = new Date()) {
  if (!isValidClinicDate(date) || !isValidClinicTime(time)) throw new Error("Invalid appointment date or time.");
  const current = getClinicNowParts(now);
  const appointmentKey = `${date} ${time}`;
  const currentKey = `${current.date} ${current.time}`;
  return appointmentKey < currentKey ? -1 : appointmentKey > currentKey ? 1 : 0;
}
