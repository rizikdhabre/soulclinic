"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { CalendarDays, ChevronDown, ChevronUp, LockKeyhole, LockKeyholeOpen, Plus } from "lucide-react";
import NeonLoader from "../ui/loading";

const WEEKDAYS = ["الأحد", "الاثنين", "الثلاثاء", "الأربعاء", "الخميس", "الجمعة", "السبت"];
const DEFAULT_TIMES = Array.from({ length: 20 }, (_, index) =>
  `${String(10 + Math.floor(index / 2)).padStart(2, "0")}:${index % 2 ? "30" : "00"}`,
);
const CONTROL = "min-h-11 rounded-xl border border-border bg-background px-3 py-2 text-sm disabled:cursor-not-allowed disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2";
const ACTION = `${CONTROL} inline-flex items-center justify-center gap-2 hover:bg-secondary`;
const STATUS = {
  apply: "سيُطبّق",
  past: "تاريخ مضى",
  excluded: "مستثنى",
  invalid: "بيانات تحتاج مراجعة",
};

function clinicDate() {
  const parts = new Intl.DateTimeFormat("en", { timeZone: "Asia/Jerusalem", year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(new Date());
  return ["year", "month", "day"].map(type => parts.find(part => part.type === type).value).join("-");
}

function newGroup(id) {
  return { id, weekdays: [], mode: "times", referenceDate: null, slots: DEFAULT_TIMES.map((time, index) => ({ id: index, time, blocked: false })) };
}

function referenceDay(days, preferCustomized = false) {
  const ordered = [...days].filter(day => day.valid).sort((a, b) => a.date.localeCompare(b.date));
  const upcoming = ordered.filter(day => day.date >= clinicDate());
  const relevant = upcoming.length ? upcoming : ordered;
  return (preferCustomized && (relevant.find(day => day.customized) || ordered.find(day => day.customized))) || relevant[0];
}

function hydrateGroup(group, day) {
  if (!day) return group;
  // Short legacy lists omitted starts entirely. Keep those starts visibly
  // blocked; a full edited list already represents every row's identity.
  const omitted = day.times.length < DEFAULT_TIMES.length ? DEFAULT_TIMES.filter(time => !day.times.includes(time)) : [];
  const times = [...day.times, ...omitted].sort();
  const closed = !day.times.length || day.times.every(time => day.blockedTimes.includes(time));
  return { ...group, referenceDate: day.date, mode: closed ? "closed" : "times", slots: times.map((time, id) => ({ id, time, blocked: day.blockedTimes.includes(time) || omitted.includes(time) })) };
}

function scheduleSignature(day) {
  return JSON.stringify([day.valid, [...day.times].sort(), [...day.blockedTimes].sort()]);
}

function validMonthState(data, month) {
  const count = new Date(`${month}-01T12:00:00Z`);
  count.setUTCMonth(count.getUTCMonth() + 1, 0);
  return data?.month === month && Array.isArray(data.days) && data.days.length === count.getUTCDate()
    && new Set(data.days.map(day => day.date)).size === data.days.length
    && data.days.every(day => typeof day.date === "string" && day.date.startsWith(`${month}-`) && Number.isInteger(day.weekday)
      && typeof day.valid === "boolean" && typeof day.customized === "boolean"
      && [day.times, day.blockedTimes, day.appointmentTimes].every(times => Array.isArray(times) && times.every(time => typeof time === "string" && /^\d{2}:\d{2}$/.test(time))));
}

function validate(month, groups) {
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) return "اختر شهراً صالحاً للمعاينة.";
  if (!groups.some(group => group.weekdays.length)) return "اختر يوماً واحداً على الأقل للمعاينة.";
  for (let index = 0; index < groups.length; index += 1) {
    const group = groups[index];
    if (!group.weekdays.length) continue;
    if (group.mode === "closed") continue;
    if (group.slots.some(slot => !/^(?:1[0-9]):[0-5]\d$/.test(slot.time) || slot.time < "10:00" || slot.time > "19:30")) {
      return `أوقات المجموعة ${index + 1} يجب أن تكون بين 10:00 و19:30.`;
    }
    if (new Set(group.slots.map(slot => slot.time)).size !== group.slots.length) return `هناك وقت بدء مكرر في المجموعة ${index + 1}. عدّله قبل المعاينة.`;
  }
  return "";
}

function toIntent(month, groups, excludedDates) {
  return {
    month,
    groups: groups.filter(group => group.weekdays.length).map(group => ({
      weekdays: [...group.weekdays].sort((a, b) => a - b),
      mode: group.mode,
      ...(group.mode === "times" ? {
        times: group.slots.map(slot => slot.time).sort(),
        blockedTimes: group.slots.filter(slot => slot.blocked).map(slot => slot.time).sort(),
      } : {}),
    })),
    excludedDates: [...excludedDates].sort(),
  };
}

function requestId() {
  if (typeof crypto.randomUUID === "function") return crypto.randomUUID();
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6] & 15) | 64;
  bytes[8] = (bytes[8] & 63) | 128;
  const hex = Array.from(bytes, byte => byte.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function serverError(data, fallback) {
  const messages = {
    SCHEDULE_CHANGED: "تغير الجدول أو أحد الحجوزات منذ المعاينة. أعد المعاينة لمراجعة الوضع الحالي قبل التطبيق.",
    REQUEST_ID_REUSED: "تعذر استخدام محاولة الحفظ هذه. أعد المعاينة قبل محاولة جديدة.",
    NO_DATES_TO_APPLY: "لا توجد أيام قابلة للتطبيق. راجع الأيام المختارة والاستثناءات والتعديلات السابقة.",
    INVALID_SCHEDULE: "بيانات الجدول غير صالحة. راجع الأيام وأوقات البدء ثم أعد المعاينة.",
    APPOINTMENT_CONFLICT: "توجد مواعيد تتعارض مع التغيير. احتفظ بأوقات الحجوزات متاحة أو استثنِ التواريخ المذكورة ثم أعد المعاينة. لم يُحفظ أي تغيير.",
  };
  return messages[data?.error] || data?.message || fallback;
}

export default function MonthlySchedulePlanner() {
  const [expanded, setExpanded] = useState(true);
  const [month, setMonth] = useState(() => clinicDate().slice(0, 7));
  const [groups, setGroups] = useState(() => [newGroup(0)]);
  const [excludedDates, setExcludedDates] = useState([]);
  const [saved, setSaved] = useState(null);
  const [stateStatus, setStateStatus] = useState("loading");
  const [stateError, setStateError] = useState("");
  const [preview, setPreview] = useState(null);
  const [previewValid, setPreviewValid] = useState(false);
  const [busy, setBusy] = useState("");
  const [attempt, setAttempt] = useState(null);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");
  const [conflicts, setConflicts] = useState([]);
  const [editorMinHeight, setEditorMinHeight] = useState(0);
  const busyRef = useRef(false);
  const attemptRef = useRef(null);
  const nextGroupId = useRef(1);
  const monthRef = useRef(month);
  const stateRequestRef = useRef(0);
  const scrollGuardRef = useRef(null);
  const editorRef = useRef(null);
  const locked = Boolean(busy || attempt);
  const stateReady = stateStatus === "ready" && saved?.month === month;
  const editorLocked = locked || !stateReady;
  const assignedDays = groups.flatMap(group => group.weekdays);
  const remainingDays = WEEKDAYS.map((_, day) => day).filter(day => !assignedDays.includes(day));

  const loadMonth = useCallback(async (requestedMonth, hydrate = true) => {
    const sequence = ++stateRequestRef.current;
    if (hydrate) setStateStatus("loading");
    setStateError("");
    try {
      const response = await fetch(`/api/admin/monthly-schedule/state?month=${encodeURIComponent(requestedMonth)}`, { credentials: "same-origin", cache: "no-store" });
      const data = await response.json();
      if (sequence !== stateRequestRef.current || monthRef.current !== requestedMonth) return;
      if (!response.ok || !validMonthState(data, requestedMonth)) throw new Error(response.status === 401 || response.status === 403 ? "auth" : "state");
      setSaved(data);
      setStateStatus("ready");
      if (hydrate) {
        setGroups([hydrateGroup(newGroup(0), referenceDay(data.days, true))]);
        nextGroupId.current = 1;
      }
    } catch (failure) {
      if (sequence !== stateRequestRef.current || monthRef.current !== requestedMonth) return;
      setStateStatus("error");
      setPreviewValid(false);
      setStateError(failure.message === "auth" ? "تعذر تحميل الجدول المحفوظ. تحقق من تسجيل الدخول بحساب المشرف ثم أعد التحميل." : "تعذر تحميل الجدول المحفوظ. أعد التحميل قبل المعاينة أو التطبيق.");
    }
  }, []);

  useEffect(() => {
    monthRef.current = month;
    if (/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) loadMonth(month);
    else { setStateStatus("error"); setStateError("اختر شهراً صالحاً لتحميل الجدول المحفوظ."); }
    return () => { stateRequestRef.current += 1; };
  }, [month, loadMonth]);

  useEffect(() => () => scrollGuardRef.current?.dispose(), []);

  function preserveViewport() {
    scrollGuardRef.current?.dispose();
    const x = window.scrollX;
    const y = window.scrollY;
    let deliberateScroll = false;
    let disposed = false;
    const mark = () => { deliberateScroll = true; };
    const key = event => { if (["ArrowUp", "ArrowDown", "PageUp", "PageDown", "Home", "End", " "].includes(event.key)) mark(); };
    const scrollbar = event => {
      const root = document.documentElement;
      if (event.clientX >= root.clientWidth || event.clientX < window.innerWidth - root.clientWidth || event.clientY >= root.clientHeight) mark();
    };
    window.addEventListener("wheel", mark, { passive: true });
    window.addEventListener("touchmove", mark, { passive: true });
    window.addEventListener("keydown", key);
    window.addEventListener("pointerdown", scrollbar, { passive: true });
    const guard = {
      dispose() {
        disposed = true;
        window.removeEventListener("wheel", mark);
        window.removeEventListener("touchmove", mark);
        window.removeEventListener("keydown", key);
        window.removeEventListener("pointerdown", scrollbar);
      },
      restore() {
        requestAnimationFrame(() => requestAnimationFrame(() => {
          if (!disposed && !deliberateScroll) window.scrollTo({ left: x, top: y, behavior: "instant" });
          guard.dispose();
        }));
      },
    };
    scrollGuardRef.current = guard;
    return guard;
  }

  function edit(change) {
    if (busyRef.current || attemptRef.current) return;
    change();
    setPreviewValid(false);
    setError("");
    setSuccess("");
    setConflicts([]);
    setEditorMinHeight(0);
  }

  function editGroup(id, change) {
    edit(() => setGroups(current => current.map(group => group.id === id ? change(group) : group)));
  }

  function editSlot(groupId, slotId, change) {
    editGroup(groupId, group => ({ ...group, slots: group.slots.map(slot => slot.id === slotId ? change(slot) : slot) }));
  }

  function selectDays(groupId, weekdays) {
    editGroup(groupId, current => {
      const hydrated = current.weekdays.length === 0 && weekdays.length ? hydrateGroup(current, referenceDay(saved.days.filter(day => weekdays.includes(day.weekday)))) : current;
      return { ...hydrated, weekdays };
    });
  }

  async function loadPreview() {
    if (busyRef.current || attemptRef.current || !stateReady) return;
    const problem = validate(month, groups);
    if (problem) { setError(problem); return; }
    busyRef.current = true;
    setBusy("preview");
    setError("");
    setSuccess("");
    setConflicts([]);
    setPreviewValid(false);
    const intent = toIntent(month, groups, excludedDates);
    try {
      const response = await fetch("/api/admin/monthly-schedule/preview", {
        method: "POST", credentials: "same-origin", cache: "no-store",
        headers: { "Content-Type": "application/json" }, body: JSON.stringify(intent),
      });
      const data = await response.json();
      if (!response.ok) {
        setError(response.status === 401 || response.status === 403 ? "تحقق من تسجيل الدخول بحساب المشرف ثم أعد المعاينة." : serverError(data, "تعذرت المعاينة. حاول مرة أخرى."));
        return;
      }
      if (!data.previewToken || !Array.isArray(data.days) || !data.summary || !Array.isArray(data.conflicts) || typeof data.canApply !== "boolean") {
        setError("تعذرت قراءة المعاينة. أعد المحاولة.");
        return;
      }
      setPreview({ ...data, intent, groupNumbers: groups.flatMap((group, index) => group.weekdays.length ? [index + 1] : []) });
      setConflicts(data.conflicts);
      setPreviewValid(true);
    } catch {
      setError("تعذرت المعاينة. تحقق من الاتصال وأعد المحاولة.");
    } finally {
      busyRef.current = false;
      setBusy("");
    }
  }

  async function applySchedule() {
    if (busyRef.current) return;
    if (!attemptRef.current && (!stateReady || !previewValid || !preview?.summary.apply || !preview.canApply || conflicts.length)) return;
    const viewport = preserveViewport();
    setEditorMinHeight(editorRef.current?.getBoundingClientRect().height || 0);
    const retryingUncertainAttempt = Boolean(attemptRef.current);
    const payload = attemptRef.current || { ...preview.intent, previewToken: preview.previewToken, requestId: requestId() };
    attemptRef.current = payload;
    setAttempt(payload);
    busyRef.current = true;
    setBusy("apply");
    setError("");
    setSuccess("");
    try {
      const response = await fetch("/api/admin/monthly-schedule/apply", {
        method: "POST", credentials: "same-origin", cache: "no-store",
        headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload),
      });
      if (response.status >= 500) throw new Error("uncertain");
      const data = await response.json();
      if (!response.ok) {
        const needsSignIn = response.status === 401 || response.status === 403;
        // Authentication or validation failures on a retry cannot resolve an
        // earlier lost response. Only a definitive schedule conflict can.
        if (retryingUncertainAttempt && !["SCHEDULE_CHANGED", "REQUEST_ID_REUSED", "APPOINTMENT_CONFLICT"].includes(data?.error)) {
          setError(needsSignIn ? "لم نتأكد من نتيجة الحفظ السابق. تحقق من تسجيل الدخول بحساب المشرف في صفحة أخرى، ثم أعد محاولة الحفظ هنا للتحقق من الطلب نفسه." : "لم نتأكد من نتيجة الحفظ السابق. تعذر التحقق الآن؛ أعد محاولة الحفظ للطلب نفسه قبل إجراء أي تعديل.");
          return;
        }
        attemptRef.current = null;
        setAttempt(null);
        setPreviewValid(false);
        setConflicts(Array.isArray(data.conflicts) ? data.conflicts : []);
        setError(needsSignIn ? "تحقق من تسجيل الدخول بحساب المشرف ثم أعد المعاينة." : serverError(data, "لم يُطبّق الجدول. أعد المعاينة وحاول مرة أخرى."));
        return;
      }
      if (data.success !== true || data.requestId !== payload.requestId || !Array.isArray(data.appliedDates)) throw new Error("uncertain");
      attemptRef.current = null;
      setAttempt(null);
      setPreviewValid(false);
      setSuccess(`تم تطبيق الجدول على ${data.appliedDates.length} يوم. جميع الحجوزات القائمة محفوظة.`);
      setConflicts([]);
      window.dispatchEvent(new CustomEvent("appointments:changed", { detail: { month: payload.month, appliedDates: data.appliedDates } }));
      await loadMonth(payload.month, false);
    } catch {
      setError("لم نتأكد من نتيجة الحفظ. احتفظ بهذه الصفحة مفتوحة واضغط إعادة محاولة الحفظ للتحقق من الطلب نفسه بأمان. التعديل والمعاينة متوقفان حتى تتأكد النتيجة.");
    } finally {
      busyRef.current = false;
      setBusy("");
      viewport.restore();
    }
  }

  return (
    <section className="card-elevated min-w-0 space-y-6 p-4 sm:p-6" dir="rtl" aria-labelledby="monthly-schedule-title" aria-busy={Boolean(busy)}>
      <header className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-2 text-primary">
          <CalendarDays size={22} aria-hidden="true" />
          <h3 id="monthly-schedule-title" className="text-lg font-semibold">تنظيم أوقات الشهر</h3>
        </div>
        <button type="button" onClick={() => { scrollGuardRef.current?.dispose(); setExpanded(value => !value); }} aria-expanded={expanded} aria-controls="monthly-schedule-content" aria-label={`${expanded ? "طي" : "توسيع"} تنظيم أوقات الشهر`} className="min-h-11 min-w-11 shrink-0 rounded-lg p-2 hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary">
          {expanded ? <ChevronUp className="mx-auto h-5 w-5" aria-hidden="true" /> : <ChevronDown className="mx-auto h-5 w-5" aria-hidden="true" />}
        </button>
      </header>

      <div id="monthly-schedule-content" hidden={!expanded} className="space-y-6">
      <p className="text-sm leading-7 text-muted-foreground">حدد أيام الأسبوع وأوقات بدء المواعيد لكل مجموعة، ثم راجع التواريخ قبل التطبيق. تُتجاوز الأيام الماضية حسب توقيت القدس؛ ويمكن تعديل اليوم الحالي.</p>
      <fieldset ref={editorRef} style={{ minHeight: editorMinHeight || undefined }} disabled={locked} className="min-w-0 space-y-5">
        <div className="grid gap-4 sm:grid-cols-2">
          <label className="flex min-w-0 flex-col gap-2 text-sm font-medium">
            الشهر
            <input type="month" value={month} className={`${CONTROL} w-full min-w-0`} onChange={event => edit(() => { monthRef.current = event.target.value; stateRequestRef.current += 1; setStateStatus("loading"); setMonth(event.target.value); setExcludedDates([]); setPreview(null); })} />
          </label>
        </div>
        <p className="rounded-xl border border-border bg-secondary/40 p-3 text-sm leading-7 text-muted-foreground">سيحل الجدول الجديد محل أوقات البدء والحظر في التواريخ المختارة. لن يُحفظ أي تغيير إذا تعارض مع وقت موعد محجوز؛ يمكنك استثناء التاريخ من المعاينة.</p>

        {stateStatus === "loading" && <p className="text-sm text-muted-foreground">جارٍ تحميل الجدول المحفوظ...</p>}
        {stateError && <div className="space-y-2"><p role="alert" className="text-sm leading-7 text-destructive">{stateError}</p><button type="button" className={ACTION} onClick={() => loadMonth(month, saved?.month !== month)}>إعادة تحميل الجدول</button></div>}
        <fieldset disabled={editorLocked} className="space-y-4">
          {groups.map((group, groupIndex) => (
            <fieldset key={group.id} className="min-w-0 rounded-2xl border border-border bg-background/60 p-3 sm:p-4">
              <legend className="px-2 font-semibold">المجموعة {groupIndex + 1}</legend>
              <div className="space-y-4 pt-2">
                <p className="text-sm text-muted-foreground">أيام الأسبوع</p>
                <div className="flex flex-wrap gap-2">
                  {WEEKDAYS.map((name, day) => {
                    const selected = group.weekdays.includes(day);
                    const taken = assignedDays.includes(day) && !selected;
                    return <button key={name} type="button" aria-pressed={selected} disabled={taken} title={taken ? "مختار في مجموعة أخرى" : undefined} className={`${ACTION} ${selected ? "border-primary bg-primary text-primary-foreground hover:bg-primary/90" : ""}`} onClick={() => selectDays(group.id, selected ? group.weekdays.filter(value => value !== day) : [...group.weekdays, day])}>{name}</button>;
                  })}
                </div>
                <button type="button" className={`${ACTION} text-primary`} disabled={!remainingDays.length} onClick={() => selectDays(group.id, [...group.weekdays, ...remainingDays])}>اختيار الأيام المتبقية</button>
                {group.referenceDate && <p className="text-sm text-muted-foreground">المرجع المحفوظ: {group.referenceDate}</p>}
                {saved?.month === month && group.weekdays.length > 0 && new Set(saved.days.filter(day => group.weekdays.includes(day.weekday)).map(scheduleSignature)).size > 1 && <p className="rounded-xl border border-amber-300 bg-amber-50 p-3 text-sm leading-7 text-amber-950">تختلف الجداول المحفوظة بين التواريخ المختارة. تعرض الصفوف جدول المرجع أعلاه، وسيُطبّق القالب الحالي على جميع الأيام المختارة بعد المعاينة.</p>}
                <div className="flex flex-wrap gap-2 border-t border-border pt-4" aria-label={`نوع الجدول للمجموعة ${groupIndex + 1}`}>
                  {[['times', 'تعديل أوقات البدء'], ['closed', 'إغلاق اليوم بالكامل']].map(([mode, label]) => <button type="button" key={mode} aria-pressed={group.mode === mode} className={`${ACTION} ${group.mode === mode ? "border-primary bg-primary/10 text-primary" : ""}`} onClick={() => editGroup(group.id, current => ({ ...current, mode }))}>{label}</button>)}
                </div>
                {group.mode === "closed" && <p className="rounded-xl bg-red-50 p-3 text-sm leading-7 text-red-900">جميع أوقات البدء محظورة في وضع الإغلاق الكامل. إذا وجد موعد محجوز في أي تاريخ مختار فلن يُحفظ أي تغيير.</p>}
                  <div className="space-y-3">
                    <div>
                      <h4 className="font-medium">أوقات بدء المواعيد</h4>
                      <p className="text-sm leading-7 text-muted-foreground">من 10:00 إلى 19:30. القفل يمنع بدء موعد في هذا الوقت فقط؛ ولا يحظر فترة زمنية أو يغيّر مدة العلاج.</p>
                    </div>
                    <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-3">
                      {group.slots.map((slot, slotIndex) => {
                        const blocked = group.mode === "closed" || slot.blocked;
                        return <div key={slot.id} className={`flex min-w-0 items-center gap-2 rounded-xl border p-2 ${blocked ? "border-red-200 bg-red-50" : "border-border"}`}>
                          <label className="min-w-0 flex-1">
                            <span className="sr-only">وقت البدء {slotIndex + 1} للمجموعة {groupIndex + 1}</span>
                            <input type="time" min="10:00" max="19:30" step="60" value={slot.time} disabled={group.mode === "closed"} dir="ltr" className={`${CONTROL} w-full min-w-0 px-2`} onChange={event => editSlot(group.id, slot.id, current => ({ ...current, time: event.target.value }))} />
                          </label>
                          <button type="button" disabled={group.mode === "closed"} className={`${ACTION} shrink-0 px-3 ${blocked ? "border-primary bg-primary text-primary-foreground hover:bg-primary/90 disabled:!opacity-100" : ""}`} aria-label={`${blocked ? "إلغاء حظر" : "حظر"} ${slot.time || "وقت البدء"}`} aria-pressed={blocked} onClick={() => editSlot(group.id, slot.id, current => ({ ...current, blocked: !current.blocked }))}>
                            {blocked ? <LockKeyhole size={18} aria-hidden="true" /> : <LockKeyholeOpen size={18} aria-hidden="true" />}
                          </button>
                        </div>
                      })}
                    </div>
                  </div>
              </div>
            </fieldset>
          ))}
        </fieldset>
        <div className="flex flex-wrap items-center gap-3">
          <button type="button" className={ACTION} disabled={editorLocked || groups.length >= 7 || !remainingDays.length} onClick={() => edit(() => setGroups(current => [...current, newGroup(nextGroupId.current++)]))}><Plus size={18} aria-hidden="true" /> إضافة مجموعة</button>
          <p className="text-sm text-muted-foreground">{remainingDays.length ? `الأيام غير المختارة: ${remainingDays.map(day => WEEKDAYS[day]).join("، ")}` : "جميع أيام الأسبوع موزعة على المجموعات."}</p>
        </div>
      </fieldset>

      <div className="space-y-4 border-t border-border pt-5">
        <button type="button" className={`${ACTION} w-full border-primary text-primary sm:w-auto`} disabled={editorLocked} onClick={loadPreview}>معاينة التغييرات</button>
        {preview && (
          <div className="space-y-4" aria-label="معاينة الجدول">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h4 className="font-semibold">التواريخ والتغييرات</h4>
            </div>
            <div className="grid grid-cols-2 gap-2 lg:grid-cols-4">
              {[["أيام للتطبيق", preview.summary.apply], ["أيام متجاوزة", preview.summary.skipped], ["مواعيد موجودة", preview.summary.existingAppointments], ["مواعيد متعارضة", preview.summary.affectedAppointments]].map(([label, count]) => (
                <div className="rounded-xl border border-border bg-secondary/40 p-3" key={label}><p className="text-2xl font-semibold tabular-nums">{count}</p><p className="text-sm leading-6 text-muted-foreground">{label}</p></div>
              ))}
            </div>
            <p className="text-sm leading-7 text-muted-foreground">يُرفض التطبيق بالكامل إذا أزيل وقت بدء محجوز أو حُظر. عدد المواعيد الموجودة يشمل الأيام المتجاوزة. استثنِ أي تاريخ تريد الحفاظ عليه، ثم أعد المعاينة.</p>
            {!preview.summary.apply && <p className="rounded-xl bg-secondary p-3 text-sm">لا توجد أيام قابلة للتطبيق في هذه المعاينة.</p>}
            <div className="max-h-[36rem] space-y-3 overflow-y-auto rounded-xl border border-border p-2 sm:p-3">
              {preview.days.map(day => (
                <article key={day.date} className="min-w-0 space-y-2 rounded-xl border border-border bg-background p-3">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div className="flex flex-wrap items-center gap-2"><time dateTime={day.date} dir="ltr" className="font-medium tabular-nums">{day.date}</time><span className={`rounded-md px-2 py-1 text-xs ${day.status === "apply" ? "bg-primary/10 text-primary" : "bg-secondary text-secondary-foreground"}`}>{STATUS[day.status] || day.status}</span><span className="text-xs text-muted-foreground">المجموعة {preview.groupNumbers[day.groupIndex]}</span></div>
                    <label className="flex min-h-11 items-center gap-2 text-sm"><input type="checkbox" className="h-4 w-4 accent-primary" aria-label={`استثناء ${day.date}`} checked={excludedDates.includes(day.date)} disabled={locked || day.status === "past" || day.status === "invalid"} onChange={event => edit(() => setExcludedDates(current => event.target.checked ? [...current, day.date] : current.filter(date => date !== day.date)))} />استثناء</label>
                  </div>
                  <details className="text-sm">
                    <summary className="cursor-pointer py-2 text-primary">عرض أوقات البدء والحظر</summary>
                    <dl className="grid min-w-0 gap-3 pt-2 sm:grid-cols-2">
                      {[["أوقات البدء السابقة", day.previousTimes], ["أوقات البدء بعد التطبيق", day.nextTimes], ["الحظر السابق", day.previousBlockedTimes], ["الحظر بعد التطبيق", day.nextBlockedTimes]].map(([label, times]) => <div key={label} className="min-w-0"><dt className="mb-1 text-muted-foreground">{label}</dt><dd className="break-words leading-7" dir="ltr">{times?.length ? times.join(" · ") : "—"}</dd></div>)}
                    </dl>
                  </details>
                  {day.appointmentCount > 0 && <p className="text-sm text-muted-foreground">المواعيد الموجودة: {day.appointmentCount}؛ المتعارضة مع التغيير: {day.affectedAppointmentCount}.</p>}
                </article>
              ))}
            </div>
          </div>
        )}
        <div className="h-56 space-y-3 overflow-y-auto" aria-live="polite">
        {error && <p role="alert" className="break-words rounded-xl border border-destructive/40 bg-destructive/5 p-4 text-sm leading-7 text-destructive">{error}</p>}
        {success && <p role="status" className="rounded-xl border border-primary/30 bg-primary/10 p-4 text-sm leading-7 text-primary">{success}</p>}
        {busy && !success && <div role="status" className="flex flex-wrap items-center gap-3 text-sm text-primary"><NeonLoader width={100} height={36} /><span>{busy === "preview" ? "جارٍ إعداد المعاينة..." : "جارٍ التحقق من الحفظ..."}</span></div>}
        {conflicts.length > 0 && <section aria-label="مواعيد تتعارض مع التغيير" className="rounded-xl border border-red-200 bg-red-50 p-3 text-sm text-red-900"><h4 className="font-semibold">مواعيد تتعارض مع التغيير</h4><p className="leading-7">احتفظ بهذه الأوقات متاحة أو استثنِ تواريخها، ثم أعد المعاينة.</p><ul>{conflicts.map(({ date, time }) => <li key={`${date}-${time}`} className="flex gap-3 py-1"><time dateTime={date} dir="ltr">{date}</time><span dir="ltr">{time}</span></li>)}</ul></section>}
        {preview && !previewValid && !success && !error && !busy && <p className="text-sm text-amber-950">المعاينة السابقة غير صالحة للتطبيق. أعد المعاينة.</p>}
        </div>
        {attempt ? <button type="button" disabled={Boolean(busy)} className={`${ACTION} w-full border-primary bg-primary text-primary-foreground hover:bg-primary/90 sm:w-auto`} onClick={applySchedule}>إعادة محاولة الحفظ</button> : <button type="button" disabled={Boolean(busy) || !stateReady || !previewValid || !preview?.summary.apply || !preview.canApply || conflicts.length > 0} className={`${ACTION} w-full border-primary bg-primary text-primary-foreground hover:bg-primary/90 sm:w-auto`} onClick={applySchedule}>تطبيق الجدول</button>}
      </div>
      </div>
    </section>
  );
}
