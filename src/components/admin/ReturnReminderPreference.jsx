"use client";

import { useEffect, useId, useRef, useState } from "react";
import { BellRing, Check, Clock3 } from "lucide-react";
import NeonLoader from "@/components/ui/loading";
import ReturnReminderComments from "./ReturnReminderComments";
import ReturnReminderStatus from "./ReturnReminderStatus";

const buttonClass = "min-h-11 rounded-xl border border-border px-4 py-2 text-sm disabled:cursor-not-allowed disabled:opacity-50";

function validSchedule(schedule) {
  return schedule?.mode === "default" || schedule?.mode === "custom" && ["days", "months"].includes(schedule.unit) && Number.isSafeInteger(schedule.value) && schedule.value > 0 && schedule.value <= (schedule.unit === "days" ? 3650 : 120);
}

function readSettings(data) {
  if (typeof data.enabled !== "boolean" || !validSchedule(data.schedule) || !Number.isSafeInteger(data.scheduleRevision) || data.scheduleRevision < 0) throw new Error("Invalid settings");
  return data;
}

function draftFrom(schedule) {
  return schedule.mode === "custom" ? { ...schedule, value: String(schedule.value) } : { mode: "default", value: "25", unit: "days" };
}

function duration(value, unit) {
  if (unit === "months") return value === 1 ? "شهر واحد" : value === 2 ? "شهرين" : value <= 10 ? `${value} أشهر` : `${value} شهرًا`;
  return value === 1 ? "يوم واحد" : value === 2 ? "يومين" : value <= 10 ? `${value} أيام` : `${value} يومًا`;
}

// A customer change creates a fresh session, including consent and private drafts.
export default function ReturnReminderPreference({ userId, statusRefreshVersion = 0 }) {
  return <PreferenceSession key={userId} userId={userId} statusRefreshVersion={statusRefreshVersion} />;
}

function PreferenceSession({ userId, statusRefreshVersion }) {
  const [settings, setSettings] = useState(null);
  const [draft, setDraft] = useState(null);
  const [consentConfirmed, setConsentConfirmed] = useState(false);
  const [loadError, setLoadError] = useState("");
  const [saveError, setSaveError] = useState("");
  const [scheduleError, setScheduleError] = useState("");
  const [conflict, setConflict] = useState(false);
  const [notice, setNotice] = useState("");
  const [retry, setRetry] = useState(0);
  const [statusVersion, setStatusVersion] = useState(0);
  const [pending, setPending] = useState(false);
  const saving = useRef(false);
  const active = useRef(false);
  const id = useId();
  const endpoint = `/api/admin/users/${encodeURIComponent(userId)}/return-reminders`;

  useEffect(() => {
    active.current = true;
    const controller = new AbortController();
    let current = true;
    async function load() {
      try {
        const response = await fetch(endpoint, { cache: "no-store", signal: controller.signal });
        if (!response.ok) throw new Error("Unavailable");
        const data = readSettings(await response.json());
        if (current) { setSettings(data); setDraft(draftFrom(data.schedule)); setLoadError(""); }
      } catch {
        if (current) setLoadError("تعذر تحميل إعداد تذكيرات العودة. حاول مرة أخرى.");
      }
    }
    load();
    return () => { current = false; active.current = false; controller.abort(); };
  }, [endpoint, retry]);

  async function saveConsent(nextEnabled) {
    if (saving.current || !settings || nextEnabled && !consentConfirmed) return;
    saving.current = true; setPending(true); setSaveError("");
    try {
      const response = await fetch(endpoint, {
        method: "PATCH", cache: "no-store", headers: { "Content-Type": "application/json" },
        body: JSON.stringify(nextEnabled ? { enabled: true, consentConfirmed: true } : { enabled: false }),
      });
      if (!response.ok) throw new Error("Unavailable");
      const data = await response.json();
      if (typeof data.enabled !== "boolean") throw new Error("Invalid response");
      if (active.current) { setSettings(current => ({ ...current, enabled: data.enabled })); setConsentConfirmed(false); setStatusVersion(value => value + 1); }
    } catch {
      if (active.current) setSaveError("تعذر تأكيد حفظ الإعداد. حاول مرة أخرى.");
    } finally {
      saving.current = false; if (active.current) setPending(false);
    }
  }

  async function saveSchedule(schedule) {
    if (saving.current || !settings || conflict || !validSchedule(schedule)) return;
    saving.current = true; setPending(true); setScheduleError(""); setNotice("");
    try {
      const response = await fetch(endpoint, {
        method: "PATCH", cache: "no-store", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ schedule, scheduleRevision: settings.scheduleRevision }),
      });
      if (response.status === 409) {
        if (active.current) { setConflict(true); setScheduleError("تغيّر جدول التذكير لدى مسؤول آخر. حدّثه وراجع أحدث إعداد قبل الحفظ."); }
        return;
      }
      if (!response.ok) throw new Error("Unavailable");
      const data = readSettings(await response.json());
      if (active.current) {
        setSettings(data); setDraft(draftFrom(data.schedule));
        setStatusVersion(value => value + 1);
        if (data.enabled !== settings.enabled) setConsentConfirmed(false);
        setNotice(schedule.mode === "default" ? "تم حفظ الجدول الافتراضي" : "تم حفظ الإعدادات");
      }
    } catch {
      if (active.current) setScheduleError("تعذر تأكيد حفظ جدول التذكير. حاول مرة أخرى.");
    } finally {
      saving.current = false; if (active.current) setPending(false);
    }
  }

  async function refreshSchedule() {
    if (saving.current) return;
    saving.current = true; setPending(true);
    try {
      const response = await fetch(endpoint, { cache: "no-store" });
      if (!response.ok) throw new Error("Unavailable");
      const data = readSettings(await response.json());
      if (active.current) {
        setSettings(data); setConflict(false); setScheduleError("");
        setStatusVersion(value => value + 1);
        if (data.enabled !== settings.enabled) setConsentConfirmed(false);
        const latest = data.schedule.mode === "default" ? "الجدول الافتراضي" : duration(data.schedule.value, data.schedule.unit);
        setNotice(`أحدث إعداد محفوظ: ${latest}. احتُفظ بمسودتك؛ راجعها قبل الحفظ.`);
      }
    } catch {
      if (active.current) setScheduleError("تعذر تحديث جدول التذكير. حاول مرة أخرى.");
    } finally {
      saving.current = false; if (active.current) setPending(false);
    }
  }

  const candidate = draft?.mode === "default" ? { mode: "default" } : { mode: "custom", value: Number(draft?.value), unit: draft?.unit };
  const valid = validSchedule(candidate);
  const changed = settings && JSON.stringify(candidate) !== JSON.stringify(settings.schedule);
  function changeDraft(change) { setDraft(current => ({ ...current, ...change })); setNotice(""); }

  return <section dir="rtl" aria-labelledby={`${id}-heading`} className="min-w-0 rounded-2xl border border-border bg-card p-4 shadow-sm sm:p-6">
    <div className="flex flex-wrap items-start justify-between gap-3">
      <h2 id={`${id}-heading`} className="flex items-center gap-2 text-lg font-semibold"><BellRing aria-hidden="true" className="h-5 w-5 shrink-0 text-primary" />تذكيرات العودة عبر واتساب</h2>
      {settings && <label className="flex min-h-11 cursor-pointer items-center gap-2 text-sm">
        <input type="checkbox" aria-label="تفعيل تذكيرات العودة" checked={settings.enabled} disabled={pending || !settings.enabled && !consentConfirmed} onChange={event => saveConsent(event.target.checked)} className="h-4 w-4 accent-primary" />
        <span>{settings.enabled ? "مفعّلة" : "متوقفة"}</span>
      </label>}
    </div>
    <p className="mt-2 text-xs leading-6 text-muted-foreground">تذكيرات العودة مفعّلة افتراضيًا حتى إلغاء الاشتراك. لا يغيّر هذا الإعداد رسائل المواعيد.</p>
    {!settings && !loadError && <div role="status" className="mt-3"><span className="sr-only">جارٍ تحميل إعداد التذكيرات...</span><div aria-hidden="true"><NeonLoader width={160} height={64} /></div></div>}
    {loadError && <div className="mt-4 space-y-3"><p role="alert" className="text-sm text-destructive">{loadError}</p><button type="button" onClick={() => { setLoadError(""); setRetry(value => value + 1); }} className={buttonClass}>إعادة المحاولة</button></div>}
    {settings && <>
      <div className="mt-4" aria-busy={pending}>
        <p role="status" className="text-xs text-muted-foreground">{settings.enabled ? "تذكيرات العودة مفعّلة لهذا الرقم." : "تذكيرات العودة متوقفة لهذا الرقم."}</p>
        {!settings.enabled && <div className="mt-3 space-y-3">
          <label className="flex items-start gap-3 text-sm leading-7"><input type="checkbox" checked={consentConfirmed} disabled={pending} onChange={event => setConsentConfirmed(event.target.checked)} className="mt-1.5 h-4 w-4 shrink-0 accent-primary" /><span>أؤكد أن الزبون وافق صراحةً على تلقي تذكيرات العودة عبر واتساب.</span></label>
          <button type="button" disabled={pending || !consentConfirmed} onClick={() => saveConsent(true)} className={buttonClass}>تسجيل موافقة الزبون</button>
        </div>}
        {saveError && <p role="alert" className="mt-2 text-sm text-destructive">{saveError}</p>}
        <div role="radiogroup" aria-label="نوع جدول التذكير" className="mt-4 flex flex-wrap gap-x-6 gap-y-1">
          {[["custom", "جدول مخصص"], ["default", "الجدول الافتراضي"]].map(([mode, label]) => <label key={mode} className={`flex min-h-11 cursor-pointer items-center gap-2 text-sm ${draft.mode === mode ? "text-primary" : ""}`}>
            <span className="relative flex h-[18px] w-[18px] shrink-0 items-center justify-center">
              <input type="radio" name={`${id}-mode`} value={mode} checked={draft.mode === mode} disabled={pending || conflict} onChange={() => mode === "default" ? saveSchedule({ mode: "default" }) : changeDraft({ mode })} className="absolute inset-0 m-0 h-full w-full appearance-none rounded border border-border bg-background checked:border-primary checked:bg-primary focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary disabled:opacity-50" />
              {draft.mode === mode && <Check aria-hidden="true" className="pointer-events-none relative h-3.5 w-3.5 text-primary-foreground" />}
            </span><span>{label}</span>
          </label>)}
        </div>
        {draft.mode === "custom" && <div className="mt-4">
          <label htmlFor={`${id}-value`} className="mb-2 block text-sm">التذكير بعد آخر جلسة وتكراره كل</label>
          <div className="flex max-w-sm gap-2">
            <input id={`${id}-value`} type="number" inputMode="numeric" min="1" max={draft.unit === "days" ? 3650 : 120} step="1" value={draft.value} disabled={pending} onChange={event => changeDraft({ value: event.target.value })} aria-invalid={!valid} aria-describedby={`${id}-summary ${id}-validation`} className="min-h-11 w-1/2 min-w-0 rounded-xl border border-border bg-background p-3 text-center text-base" dir="ltr" />
            <select aria-label="وحدة مدة التذكير" value={draft.unit} disabled={pending} onChange={event => changeDraft({ unit: event.target.value })} className="min-h-11 w-1/2 min-w-0 rounded-xl border border-border bg-background p-3 text-base"><option value="days">يوم</option><option value="months">شهر</option></select>
          </div>
          <p id={`${id}-validation`} className="mt-2 text-xs text-destructive" role={!valid ? "alert" : undefined}>{!valid ? `أدخل عددًا صحيحًا من 1 إلى ${draft.unit === "days" ? "3650 يومًا" : "120 شهرًا"}.` : ""}</p>
        </div>}
        <div className="mt-4 text-sm leading-7" aria-live="polite">
          <p id={`${id}-summary`}>{draft.mode === "default" ? "أول تذكير بعد 3 أشهر تقويمية من آخر جلسة حضرها الزبون، ثم كل 30 يومًا منقضيًا." : valid ? `أول تذكير بعد ${duration(candidate.value, candidate.unit)} من آخر جلسة حضرها الزبون، ثم كل ${duration(candidate.value, candidate.unit)}.` : "اختر مدة التذكير."}</p>
          <p className="text-xs text-muted-foreground">{!settings.enabled ? "لن تُرسل تذكيرات. يبقى الجدول محفوظًا." : draft.mode === "custom" ? "يُستخدم الجدول المخصص وحده لهذا الزبون." : "يُستخدم الجدول الافتراضي لهذا الزبون."}</p>
        </div>
        <p className="mt-2 flex items-start gap-2 text-xs leading-6 text-muted-foreground"><Clock3 className="mt-1 h-4 w-4 shrink-0" aria-hidden="true" /><span>الإرسال يوميًا الساعة 7:00 مساءً بتوقيت العيادة (القدس) عند استحقاق التذكير.</span></p>
        <p className="mt-1 text-xs leading-6 text-muted-foreground">تتوقف التذكيرات عند وجود موعد قادم أو إلغاء الاشتراك. تبدأ المدة من جديد بعد حضور جلسة.</p>
        <ReturnReminderStatus userId={userId} refreshVersion={`${statusRefreshVersion}:${statusVersion}`} hasUnsavedChanges={Boolean(changed)} />
        <div className="mt-4 flex flex-wrap items-center gap-3">
          {draft.mode === "custom" && <button type="button" disabled={pending || conflict || !valid || !changed} onClick={() => saveSchedule(candidate)} className={`${buttonClass} flex items-center gap-2 border-primary bg-primary text-primary-foreground`}><Check aria-hidden="true" className="h-4 w-4" />حفظ الإعدادات</button>}
          <p aria-live="polite" className="text-xs leading-6 text-primary">{notice || (changed ? "تغييرات غير محفوظة" : "")}</p>
        </div>
        {scheduleError && <p role="alert" className="mt-3 text-sm text-destructive">{scheduleError}</p>}
        {conflict && <button type="button" disabled={pending} onClick={refreshSchedule} className={`${buttonClass} mt-2`}>تحديث جدول التذكير</button>}
        {pending && <div aria-hidden="true" className="mt-2"><NeonLoader width={160} height={64} /></div>}
      </div>
      <ReturnReminderComments userId={userId} />
    </>}
  </section>;
}
