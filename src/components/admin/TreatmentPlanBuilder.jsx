"use client";

import axios from "axios";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { CalendarPlus, CheckCircle2, Plus, Trash2 } from "lucide-react";
import { getScheduleTimes, isTimeSlotAvailable } from "@/lib/appointmentRules";
import { getClinicNowParts } from "@/lib/clinicTime";

const fieldClass = "w-full min-w-0 rounded-xl border border-border bg-background px-3 py-3 text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-primary/40 disabled:cursor-not-allowed disabled:opacity-60";
const newRow = () => ({ key: crypto.randomUUID(), treatmentId: "", serviceIndex: "", date: "", time: "" });
const selectedService = (row, treatments) => row.serviceIndex === "" ? null : treatments.find(treatment => String(treatment._id) === row.treatmentId)?.services?.[Number(row.serviceIndex)] || null;

export function notificationMessage(status) {
  if (status === "sent") return "تم إرسال المواعيد إلى الزبون في رسالة واحدة.";
  if (status === "not_configured") return "لم تُرسل رسالة المواعيد لأن خدمة رسائل البرامج غير مفعّلة. المواعيد محفوظة.";
  if (status === "failed") return "تعذر إرسال رسالة المواعيد. المواعيد محفوظة؛ أبلغ الزبون بها.";
  if (status === "pending") return "المواعيد محفوظة، وإرسال الرسالة قيد المعالجة.";
  return "المواعيد محفوظة، ولم يتأكد وصول رسالة المواعيد. تحقق قبل إبلاغ الزبون مجددًا.";
}

function planErrorMessage(error) {
  const payload = error.response?.data;
  const row = Number.isInteger(payload?.rowIndex) ? `الموعد ${payload.rowIndex + 1}: ` : "";
  const messages = {
    TIME_SLOT_UNAVAILABLE: "هذه الساعة لم تعد متاحة. اختر ساعة أخرى.",
    PLAN_ROWS_OVERLAP: "يتداخل مع موعد آخر في البرنامج. غيّر الساعة أو التاريخ.",
    SERVICE_CHANGED: "تغيرت تفاصيل العلاج. راجع العلاج والسعر المحدّثين ثم احفظ البرنامج.",
    INVALID_SERVICE: "العلاج غير متاح. اختر علاجًا آخر.",
    SCHEDULE_TOO_LONG: "تفاصيل البرنامج أطول من الحد المسموح للرسالة. قلّل عدد المواعيد.",
    INVALID_CUSTOMER: "بيانات اسم الزبون غير صالحة للرسالة. راجع الاسم في قائمة الزبائن.",
    INVALID_APPOINTMENT: "اختر علاجًا صالحًا وتاريخًا وساعة في المستقبل.",
    INVALID_EXPECTED_SERVICE: "تعذر تأكيد تفاصيل العلاج. أعد اختيار العلاج وحاول مرة أخرى.",
    TRANSACTIONS_REQUIRED: "حفظ البرامج غير متاح مؤقتًا. لم تُحفظ مواعيد؛ حاول لاحقًا أو راجع إعداد الخدمة.",
    BOOKING_INDEX_UNAVAILABLE: "حفظ البرامج غير متاح مؤقتًا. لم تُحفظ مواعيد؛ حاول لاحقًا.",
    REQUEST_ID_REUSED: "تعذر تأكيد هذا الطلب. حدّث الملف وتحقق من البرامج المحفوظة قبل إنشاء برنامج جديد.",
    USER_NOT_FOUND: "لم يتم العثور على الزبون.",
  };
  if (error.response?.status === 401 || error.response?.status === 403) return "انتهت الجلسة أو لا توجد صلاحية. سجّل الدخول بحساب الإدارة.";
  return row + (messages[payload?.error] || "تعذر حفظ البرنامج. راجع تفاصيل المواعيد وحاول مرة أخرى.");
}

function PlanRow({ row, index, rows, treatments, locked, refresh, clock, onPatch, onRemove, onReadiness }) {
  const [availability, setAvailability] = useState({ date: "", status: "idle", day: null });
  const [readRetry, setReadRetry] = useState(0);
  const service = selectedService(row, treatments);
  const category = treatments.find(treatment => String(treatment._id) === row.treatmentId);
  const queryKey = `${row.date}:${refresh}:${readRetry}`;

  useEffect(() => {
    if (!row.date) return;
    let active = true;
    axios.get("/api/appointments", { params: { date: row.date, admin: true }, headers: { "Cache-Control": "no-store" } })
      .then(({ data }) => { if (active) setAvailability({ queryKey, status: "ready", day: data }); })
      .catch(() => { if (active) setAvailability({ queryKey, status: "error", day: null }); });
    return () => { active = false; };
  }, [row.date, queryKey]);

  const ready = availability.queryKey === queryKey && availability.status === "ready";
  const loading = row.date && availability.queryKey !== queryKey;
  const times = useMemo(() => {
    if (!ready || !service) return [];
    const otherAppointments = rows.filter(other => other.key !== row.key && other.date === row.date && other.time)
      .map(other => ({ time: other.time, duration: selectedService(other, treatments)?.duration }));
    const day = { ...availability.day, appointments: [...(availability.day?.appointments || []), ...otherAppointments] };
    return getScheduleTimes(day.editedTimes).filter(time =>
      (row.date > clock.date || (row.date === clock.date && time > clock.time)) &&
      isTimeSlotAvailable({ day, time, duration: service.duration }));
  }, [ready, service, rows, row.key, row.date, treatments, availability.day, clock]);
  const valid = ready && Boolean(service) && times.includes(row.time);

  useEffect(() => { onReadiness(row.key, valid); }, [onReadiness, row.key, valid]);
  useEffect(() => {
    if (!locked && ready && row.time && !times.includes(row.time)) onPatch(row.key, { time: "" });
  }, [locked, ready, row.time, row.key, times, onPatch]);

  return (
    <fieldset disabled={locked} className="min-w-0 rounded-2xl border border-border bg-muted/20 p-4 sm:p-5">
      <legend className="px-2 text-sm font-semibold">الموعد {index + 1}</legend>
      <div className="mb-3 flex justify-end"><button type="button" onClick={() => onRemove(row.key)} disabled={rows.length === 1 || locked} aria-label={`حذف الموعد ${index + 1}`} className="inline-flex items-center gap-1 rounded-lg px-2 py-1 text-xs text-muted-foreground hover:bg-muted hover:text-destructive disabled:opacity-40"><Trash2 className="h-4 w-4" aria-hidden="true" />حذف</button></div>
      <div className="grid min-w-0 grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <label className="min-w-0 space-y-2"><span className="text-sm font-medium">القسم</span>
          <select required className={fieldClass} value={row.treatmentId} onChange={event => onPatch(row.key, { treatmentId: event.target.value, serviceIndex: "", time: "" })}>
            <option value="">اختر القسم</option>{treatments.map(treatment => <option key={String(treatment._id)} value={String(treatment._id)}>{treatment.title}</option>)}
          </select>
        </label>
        <label className="min-w-0 space-y-2"><span className="text-sm font-medium">العلاج</span>
          <select required className={fieldClass} disabled={!category || locked} value={row.serviceIndex} onChange={event => onPatch(row.key, { serviceIndex: event.target.value, time: "" })}>
            <option value="">اختر العلاج</option>{category?.services?.map((item, serviceIndex) => <option key={serviceIndex} value={String(serviceIndex)}>{item.title}</option>)}
          </select>
        </label>
        <label className="min-w-0 space-y-2"><span className="text-sm font-medium">التاريخ</span><input required type="date" min={clock.date} className={fieldClass} value={row.date} onChange={event => onPatch(row.key, { date: event.target.value, time: "" })} /></label>
        <div className="min-w-0 space-y-2">
          <label className="block space-y-2"><span className="text-sm font-medium">الساعة</span>
            <select required className={fieldClass} disabled={!service || !ready || !times.length || locked} value={row.time} onChange={event => onPatch(row.key, { time: event.target.value })}>
              <option value="">{loading ? "جارٍ تحميل الساعات..." : "اختر الساعة"}</option>{times.map(time => <option key={time} value={time}>{time}</option>)}
            </select>
          </label>
          {availability.queryKey === queryKey && availability.status === "error" && <p className="text-xs text-destructive">تعذر تحميل الساعات. <button type="button" onClick={() => setReadRetry(value => value + 1)} className="underline">إعادة المحاولة</button></p>}
          {service && ready && !times.length && <p className="text-xs text-muted-foreground">لا توجد ساعات متاحة لهذا اليوم.</p>}
        </div>
      </div>
      {service && <p className="mt-4 flex flex-wrap gap-x-5 gap-y-2 text-xs text-muted-foreground"><span>مدة الجلسة: {service.duration} دقيقة</span><span>السعر: {service.price} ₪</span>{service.cupsCount !== undefined && service.cupsCount !== null && String(service.cupsCount).trim() !== "" && <span>عدد الكاسات: {service.cupsCount}</span>}</p>}
    </fieldset>
  );
}

export default function TreatmentPlanBuilder({ userId, customerName, onSaved }) {
  const [rows, setRows] = useState(() => [newRow()]);
  const [treatments, setTreatments] = useState([]);
  const [catalogStatus, setCatalogStatus] = useState("loading");
  const [catalogRetry, setCatalogRetry] = useState(0);
  const [readiness, setReadiness] = useState({});
  const [refresh, setRefresh] = useState(0);
  const [submitting, setSubmitting] = useState(false);
  const [uncertain, setUncertain] = useState(false);
  const [error, setError] = useState("");
  const [receipt, setReceipt] = useState(null);
  const [clock, setClock] = useState(getClinicNowParts);
  const requestRef = useRef(null);
  const busyRef = useRef(false);
  const locked = submitting || uncertain || Boolean(receipt);

  useEffect(() => {
    const timer = setInterval(() => setClock(getClinicNowParts()), 60000);
    return () => clearInterval(timer);
  }, []);

  useEffect(() => {
    let active = true;
    axios.get("/api/admin/treatments", { headers: { "Cache-Control": "no-store" } })
      .then(({ data }) => { if (active) { setTreatments(Array.isArray(data) ? data : []); setCatalogStatus("ready"); } })
      .catch(() => { if (active) setCatalogStatus("error"); });
    return () => { active = false; };
  }, [catalogRetry]);

  const patchRow = useCallback((key, patch) => {
    if (locked) return;
    requestRef.current = null;
    setError("");
    setRows(current => current.map(row => row.key === key ? { ...row, ...patch } : row));
  }, [locked]);
  const updateReadiness = useCallback((key, valid) => setReadiness(current => current[key] === valid ? current : { ...current, [key]: valid }), []);

  const submit = async event => {
    event.preventDefault();
    if (busyRef.current || receipt) return;
    if (!requestRef.current) {
      if (rows.some(row => !readiness[row.key])) {
        setError("اختر علاجًا وتاريخًا وساعة متاحة لكل موعد.");
        return;
      }
      requestRef.current = {
        requestId: crypto.randomUUID(),
        appointments: rows.map(row => {
          const service = selectedService(row, treatments);
          const cups = service.cupsCount;
          return { treatmentId: row.treatmentId, serviceIndex: Number(row.serviceIndex), expectedService: { title: service.title, duration: Number(service.duration), price: Number(service.price), cupsCount: cups === undefined || cups === null || String(cups).trim() === "" ? null : Number(cups) }, date: row.date, time: row.time };
        }),
      };
    }
    busyRef.current = true;
    setSubmitting(true);
    setError("");
    let saved = false;
    try {
      const { data } = await axios.post(`/api/admin/users/${encodeURIComponent(userId)}/treatment-plans`, requestRef.current);
      if (!data?.success || !data?.planId) throw new Error("Uncertain booking response");
      setReceipt(data);
      setUncertain(false);
      saved = true;
    } catch (cause) {
      const status = cause.response?.status;
      const definiteUnavailable = ["TRANSACTIONS_REQUIRED", "BOOKING_INDEX_UNAVAILABLE"].includes(cause.response?.data?.error);
      if (!status || (status >= 500 && !definiteUnavailable) || cause.response?.data?.error === "REQUEST_ID_REUSED") {
        setUncertain(true);
        setError("لم نتأكد من نتيجة الحفظ. أعد المحاولة بأمان للتحقق من نفس البرنامج دون تكرار المواعيد.");
      } else {
        requestRef.current = null;
        setUncertain(false);
        setError(planErrorMessage(cause));
        const payload = cause.response?.data;
        if (status === 409) {
          if (payload?.error === "TIME_SLOT_UNAVAILABLE" && Number.isInteger(payload.rowIndex)) setRows(current => current.map((row, index) => index === payload.rowIndex ? { ...row, time: "" } : row));
          setRefresh(value => value + 1);
          if (payload?.error === "SERVICE_CHANGED" || payload?.error === "INVALID_SERVICE") {
            // Service indexes belong to one catalog version. Require a fresh choice after a reload.
            setRows(current => current.map(row => ({ ...row, serviceIndex: "", time: "" })));
            setCatalogStatus("loading");
            setCatalogRetry(value => value + 1);
          }
        }
      }
    } finally {
      busyRef.current = false;
      setSubmitting(false);
    }
    // A refresh failure must never change a confirmed booking into a retryable submission.
    if (saved) {
      window.dispatchEvent(new CustomEvent("appointments:changed"));
      Promise.resolve().then(() => onSaved?.()).catch(() => {});
    }
  };

  const startNewPlan = () => {
    requestRef.current = null;
    setReceipt(null);
    setError("");
    setReadiness({});
    setRows([newRow()]);
    setRefresh(value => value + 1);
  };

  return (
    <section aria-labelledby="treatment-plan-heading" className="min-w-0 rounded-2xl border border-border bg-card p-4 shadow-sm sm:p-6">
      <div className="mb-5 flex items-start gap-3"><CalendarPlus className="mt-1 h-5 w-5 shrink-0 text-primary" aria-hidden="true" /><div><h2 id="treatment-plan-heading" className="text-xl font-semibold">برنامج علاجي</h2><p className="mt-2 text-sm leading-6 text-muted-foreground">حدد مواعيد {customerName}، ثم احفظ البرنامج لإرسال جميع المواعيد في رسالة واحدة.</p></div></div>
      {receipt ? <div className="rounded-xl border border-primary/20 bg-primary/5 p-5">
        <div role="status"><p className="flex items-center gap-2 font-semibold text-primary"><CheckCircle2 className="h-5 w-5" aria-hidden="true" />تم حفظ البرنامج بنجاح</p><p className="mt-3 text-sm leading-7">{notificationMessage(receipt.notification?.status)}</p><p className="mt-2 text-sm text-muted-foreground">عدد المواعيد: {receipt.appointmentIds?.length || rows.length}</p></div>
        <button type="button" onClick={startNewPlan} className="mt-5 rounded-xl border border-border bg-background px-4 py-2 text-sm font-medium hover:bg-muted">إنشاء برنامج جديد</button>
      </div> : <form onSubmit={submit} className="space-y-4">
        {catalogStatus === "loading" && <p role="status" className="text-sm text-muted-foreground">جارٍ تحميل العلاجات...</p>}
        {catalogStatus === "error" && <p role="alert" className="text-sm text-destructive">تعذر تحميل العلاجات. <button type="button" onClick={() => { setCatalogStatus("loading"); setCatalogRetry(value => value + 1); }} className="underline">إعادة المحاولة</button></p>}
        {catalogStatus === "ready" && !treatments.length && <p className="text-sm text-muted-foreground">لا توجد علاجات متاحة للحجز.</p>}
        {rows.map((row, index) => <PlanRow key={row.key} row={row} index={index} rows={rows} treatments={treatments} locked={locked || catalogStatus !== "ready"} refresh={refresh} clock={clock} onPatch={patchRow} onReadiness={updateReadiness} onRemove={key => { requestRef.current = null; setError(""); setRows(current => current.filter(item => item.key !== key)); }} />)}
        <div className="flex flex-wrap items-center justify-between gap-3"><button type="button" disabled={locked || rows.length >= 10 || catalogStatus !== "ready"} onClick={() => { requestRef.current = null; setError(""); setRows(current => [...current, newRow()]); }} className="inline-flex items-center gap-2 rounded-xl border border-border px-4 py-2.5 text-sm font-medium text-primary hover:bg-muted disabled:cursor-not-allowed disabled:opacity-50"><Plus className="h-4 w-4" aria-hidden="true" />إضافة موعد</button><p className="text-xs text-muted-foreground">{rows.length} / 10 مواعيد</p></div>
        {error && <p role="alert" className="rounded-xl bg-destructive/10 p-4 text-sm leading-7 text-destructive">{error}</p>}
        <div className="flex justify-end border-t border-border pt-5"><button type="submit" disabled={submitting || (!uncertain && (catalogStatus !== "ready" || !treatments.length))} className="w-full rounded-xl bg-primary px-5 py-3 text-sm font-semibold text-primary-foreground transition hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-50 sm:w-auto">{submitting ? "جارٍ حفظ البرنامج..." : uncertain ? "التحقق وإعادة المحاولة بأمان" : "حفظ البرنامج وإرسال المواعيد"}</button></div>
      </form>}
    </section>
  );
}
