import { isValidPainRelief } from "@/lib/feedbackRating";

const TEMPLATES = {
  appointments: "📅 مواعيد الغد — SoulClinic\n\n{{1}}\n\nانتهى الجدول.",
  feedback: "📝 تقييمات الزبائن — SoulClinic\n\n{{1}}\n\nالتقييمات الجديدة منذ التقرير السابق.",
};
const EMPTY = {
  appointments: "لا توجد مواعيد للغد.",
  feedback: "لا توجد تقييمات جديدة منذ التقرير السابق.",
};

function field(value, fallback) {
  // Template variables must be single-line. Keep user text complete while
  // reserving the two report separators for our own field/entry boundaries.
  const text = typeof value === "string" ? value.replace(/[|║]/gu, "/").replace(/\s+/gu, " ").trim() : "";
  return text || fallback;
}

export function buildAdminReportText(type, rows) {
  if (!Object.hasOwn(TEMPLATES, type)) throw new Error("INVALID_ADMIN_REPORT_TYPE");
  const text = rows.length ? rows.map((row, index) => {
    const name = field(row.name, "زبون غير متوفر");
    const title = field(row.title, "علاج غير محدد");
    const details = type === "appointments"
      ? [name, field(row.phone, "رقم غير متوفر"), title, field(row.time, "وقت غير متوفر")]
      : [name, title, isValidPainRelief(row.painRelief) ? `${row.painRelief}/10` : "غير متوفر", field(row.text, "بدون ملاحظة")];
    return `${index + 1}) ${details.join(" | ")}`;
  }).join(" ║ ") : EMPTY[type];
  // UTF-16 length is deliberately conservative for emojis; count the approved
  // static template too, not just ContentVariables. Never silently truncate.
  const characters = TEMPLATES[type].replace("{{1}}", () => text).length;
  return { text, count: rows.length, characters, fits: characters <= 1600 && text.length <= 1600 };
}
