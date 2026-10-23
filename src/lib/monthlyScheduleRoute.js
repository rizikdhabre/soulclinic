import { NextResponse } from "next/server";
import { withAdminRoute } from "@/lib/adminAuth";
import { isValidClinicDate, isValidClinicTime } from "@/lib/clinicTime";
import { normalizeMonthlyScheduleMonth } from "@/lib/monthlyScheduleRules";

const errors = {
  INVALID_SCHEDULE: [400, "تحقق من الشهر والأيام والأوقات المحددة."],
  NO_DATES_TO_APPLY: [400, "لا توجد أيام قابلة للتطبيق ضمن الاختيارات الحالية."],
  SCHEDULE_CHANGED: [409, "تغير الجدول أو الحجوزات. أعد المعاينة قبل الحفظ."],
  APPOINTMENT_CONFLICT: [409, "لا يمكن حفظ الجدول لأن التغييرات تتعارض مع مواعيد محجوزة. عدّل الأوقات المحددة وأعد المعاينة."],
  REQUEST_ID_REUSED: [409, "استُخدم معرف الطلب لعملية مختلفة. أنشئ معاينة جديدة."],
  TRANSACTIONS_REQUIRED: [503, "يتطلب حفظ الجدول دعماً للمعاملات في قاعدة البيانات."],
  SCHEDULE_STORAGE_UNAVAILABLE: [503, "تعذر تحميل أو حفظ الجدول الآن. أعد محاولة الطلب نفسه."],
};

function safeConflicts(conflicts) {
  const unique = new Map();
  if (Array.isArray(conflicts)) for (const conflict of conflicts) {
    if (isValidClinicDate(conflict?.date) && isValidClinicTime(conflict?.time)) {
      unique.set(`${conflict.date} ${conflict.time}`, { date: conflict.date, time: conflict.time });
    }
  }
  return [...unique.values()];
}

export function monthlyScheduleRoute(operation, { readMonth = false } = {}) {
  const authorized = withAdminRoute(async (request) => {
    try {
      let body;
      if (readMonth) {
        const months = new URL(request.url).searchParams.getAll("month");
        body = { month: normalizeMonthlyScheduleMonth(months.length === 1 ? months[0] : undefined) };
      } else {
        try { body = await request.json(); } catch { throw Object.assign(new Error("Invalid JSON"), { code: "INVALID_SCHEDULE" }); }
      }
      return NextResponse.json(await operation(body));
    } catch (error) {
      const code = Object.hasOwn(errors, error?.code) ? error.code : "SCHEDULE_STORAGE_UNAVAILABLE";
      const [status, message] = errors[code];
      return NextResponse.json({ error: code, message, ...(code === "APPOINTMENT_CONFLICT" ? { conflicts: safeConflicts(error.conflicts) } : {}) }, { status });
    }
  });
  return async (...args) => {
    const response = await authorized(...args);
    // Include auth failures, which return before the authorized handler runs.
    response.headers.set("Cache-Control", "private, no-store");
    return response;
  };
}
