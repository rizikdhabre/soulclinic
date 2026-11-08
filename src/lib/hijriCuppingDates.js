const TIME_ZONE = "Asia/Jerusalem";
const CUPPING_DAYS = new Set([17, 19, 21]);
const MAX_CACHED_MONTHS = 24;
const monthCache = new Map();
const hijriOptions = { calendar: "islamic-umalqura", numberingSystem: "latn", timeZone: TIME_ZONE };
const hijriDayFormatter = new Intl.DateTimeFormat("en", { ...hijriOptions, day: "numeric" });
const hijriFormatter = new Intl.DateTimeFormat("ar-SA", { ...hijriOptions, day: "numeric", month: "long", year: "numeric" });
const weekdayFormatter = new Intl.DateTimeFormat("ar", { weekday: "long", timeZone: TIME_ZONE });
const clinicDateFormatter = new Intl.DateTimeFormat("en-CA", { timeZone: TIME_ZONE, year: "numeric", month: "2-digit", day: "2-digit" });
const legendNumberFormatter = new Intl.NumberFormat("ar", { numberingSystem: "arab", useGrouping: false });

function dateAnchor(dateKey) {
  if (typeof dateKey !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(dateKey)) throw new RangeError("Invalid clinic date");
  // A civil calendar day is not a browser-local midnight. Noon UTC stays on the
  // same date in Jerusalem through both daylight-saving transitions.
  const date = new Date(`${dateKey}T12:00:00.000Z`);
  if (!Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== dateKey) throw new RangeError("Invalid clinic date");
  return date;
}

export function getClinicDateKey(now = new Date()) {
  const parts = Object.fromEntries(clinicDateFormatter.formatToParts(now).map(part => [part.type, part.value]));
  return `${parts.year}-${parts.month}-${parts.day}`;
}

export function formatCuppingDate(dateKey) {
  const date = dateAnchor(dateKey);
  const parts = hijriFormatter.formatToParts(date);
  const values = Object.fromEntries(parts.map(part => [part.type, part.value]));
  return Object.freeze({
    date: dateKey,
    day: date.getUTCDate(),
    hijriDay: Number(values.day),
    hijriMonth: values.month,
    hijriYear: values.year,
    hijriLabel: parts.map(part => part.value).join(""),
    gregorianLabel: `${dateKey.slice(8, 10)}/${dateKey.slice(5, 7)}/${dateKey.slice(0, 4)}`,
    weekday: weekdayFormatter.format(date),
  });
}

export function getCuppingMonth(year, monthIndex) {
  if (!Number.isInteger(year) || year < 1 || year > 9999 || !Number.isInteger(monthIndex) || monthIndex < 0 || monthIndex > 11) throw new RangeError("Invalid calendar month");
  const key = `${String(year).padStart(4, "0")}-${String(monthIndex + 1).padStart(2, "0")}`;
  if (monthCache.has(key)) {
    const cached = monthCache.get(key);
    monthCache.delete(key);
    monthCache.set(key, cached);
    return cached;
  }
  const cursor = dateAnchor(`${key}-01`);
  const records = [];
  while (cursor.getUTCFullYear() === year && cursor.getUTCMonth() === monthIndex) {
    const hijriDay = Number(hijriDayFormatter.formatToParts(cursor).find(part => part.type === "day").value);
    if (CUPPING_DAYS.has(hijriDay)) records.push(formatCuppingDate(cursor.toISOString().slice(0, 10)));
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  const result = Object.freeze(records);
  monthCache.set(key, result);
  if (monthCache.size > MAX_CACHED_MONTHS) monthCache.delete(monthCache.keys().next().value);
  return result;
}

export function getUpcomingCuppingDates(dateKey, count = 3) {
  const date = dateAnchor(dateKey);
  if (!Number.isSafeInteger(count) || count < 0) throw new RangeError("Invalid date count");
  const results = [];
  let year = date.getUTCFullYear();
  let month = date.getUTCMonth();
  while (results.length < count) {
    for (const record of getCuppingMonth(year, month)) {
      if (record.date >= dateKey) results.push(record);
      if (results.length === count) break;
    }
    if (++month === 12) { month = 0; year++; }
  }
  return Object.freeze(results);
}

export function formatCuppingLegend(records) {
  return records.map(record => legendNumberFormatter.format(record.day)).join("•");
}
