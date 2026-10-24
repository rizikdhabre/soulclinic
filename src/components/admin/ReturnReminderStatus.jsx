"use client";

import { useEffect, useState } from "react";
import NeonLoader from "@/components/ui/loading";

const statuses = ["scheduled", "disabled", "upcoming", "no_attendance", "unavailable"];
const clinicFormat = new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Jerusalem", day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit", hourCycle: "h23" });

function readStatus(data) {
  if (!statuses.includes(data?.status)) throw new Error("Invalid status");
  if (data.lastAttended != null && (!/^\d{4}-\d{2}-\d{2}$/.test(data.lastAttended.date) || !/^\d{2}:\d{2}$/.test(data.lastAttended.time))) throw new Error("Invalid attendance");
  for (const value of [data.lastAttemptAt, data.nextReminderAt]) {
    if (value != null && (typeof value !== "string" || !Number.isFinite(new Date(value).getTime()))) throw new Error("Invalid timestamp");
  }
  return data;
}

function attendanceLabel(attendance) {
  const [year, month, day] = attendance.date.split("-");
  return `${day}/${month}/${year} · ${attendance.time}`;
}

function nextLabel(data) {
  if (data.status === "disabled") return "التذكيرات متوقفة";
  if (data.status === "upcoming") return "متوقف لوجود موعد قادم";
  if (data.status === "no_attendance") return "بانتظار جلسة يحضرها الزبون";
  if (data.status !== "scheduled" || !data.nextReminderAt) return "تعذر تحديد الموعد";
  return clinicFormat.format(new Date(data.nextReminderAt));
}

export default function ReturnReminderStatus({ userId, refreshVersion = 0, hasUnsavedChanges = false }) {
  const [snapshot, setSnapshot] = useState(null);
  const [retry, setRetry] = useState(0);
  const endpoint = `/api/admin/users/${encodeURIComponent(userId)}/return-reminders/status`;
  const requestKey = `${endpoint}:${refreshVersion}:${retry}`;
  const current = snapshot?.key === requestKey ? snapshot : null;

  useEffect(() => {
    let active = true;
    const controller = new AbortController();
    async function load() {
      try {
        const response = await fetch(endpoint, { cache: "no-store", signal: controller.signal });
        if (!response.ok) throw new Error("Unavailable");
        const data = readStatus(await response.json());
        if (active) setSnapshot({ key: requestKey, data });
      } catch {
        if (active) setSnapshot({ key: requestKey, error: true });
      }
    }
    load();
    return () => { active = false; controller.abort(); };
  }, [endpoint, requestKey]);

  return <div role="group" aria-label="حالة تذكير العودة" aria-busy={!current} className="my-5 min-w-0 border-y border-border py-4" aria-live="polite">
    {!current && <div aria-label="جارٍ تحميل حالة التذكير"><NeonLoader width={160} height={64} /></div>}
    {current?.error && <div className="space-y-2"><p role="alert" className="text-sm text-destructive">تعذر تحميل حالة التذكير. يمكنك متابعة تعديل الإعدادات والتعليقات.</p><button type="button" onClick={() => setRetry(value => value + 1)} className="min-h-11 rounded-xl border border-border px-3 py-2 text-sm">إعادة تحميل حالة التذكير</button></div>}
    {current?.data && <>
      <dl className="grid min-w-0 gap-4 sm:grid-cols-3">
        <div className="flex min-w-0 items-baseline justify-between gap-3 sm:block"><dt className="text-xs text-muted-foreground">آخر جلسة حضرها الزبون</dt><dd className="min-w-0 text-left text-sm leading-7 [overflow-wrap:anywhere] sm:mt-1 sm:text-right">{current.data.lastAttended ? <bdi>{attendanceLabel(current.data.lastAttended)}</bdi> : current.data.status === "unavailable" ? "غير متاح" : "لا توجد جلسة حضور"}</dd></div>
        <div className="flex min-w-0 items-baseline justify-between gap-3 sm:block"><dt className="text-xs text-muted-foreground">آخر محاولة تذكير</dt><dd className="min-w-0 text-left text-sm leading-7 [overflow-wrap:anywhere] sm:mt-1 sm:text-right">{current.data.lastAttemptAt ? <bdi>{clinicFormat.format(new Date(current.data.lastAttemptAt))}</bdi> : current.data.status === "unavailable" ? "غير متاح" : "لم تُسجّل محاولة"}</dd></div>
        <div className="flex min-w-0 items-baseline justify-between gap-3 sm:block"><dt className="text-xs text-muted-foreground">التذكير القادم</dt><dd className="min-w-0 text-left text-sm leading-7 text-primary [overflow-wrap:anywhere] sm:mt-1 sm:text-right"><bdi>{nextLabel(current.data)}</bdi></dd></div>
      </dl>
      {current.data.status === "scheduled" && current.data.nextReminderAt && <p className="mt-2 text-xs leading-6 text-muted-foreground">موعد متوقع وفق الإعدادات المحفوظة وبتوقيت العيادة؛ يُعاد التحقق من الاستحقاق عند الإرسال.</p>}
      {hasUnsavedChanges && <p className="mt-2 text-xs leading-6 text-primary">الموعد المعروض حسب الجدول المحفوظ؛ احفظ التغييرات لتحديثه.</p>}
    </>}
  </div>;
}
