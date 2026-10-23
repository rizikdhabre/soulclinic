"use client";

import axios from "axios";
import { useEffect, useRef, useState } from "react";
import { CheckCircle2, MessageSquare } from "lucide-react";

export default function FeedbackClient({ token }) {
  const [appointment, setAppointment] = useState(null);
  const [state, setState] = useState("loading");
  const [error, setError] = useState("");
  const [text, setText] = useState("");
  const [retry, setRetry] = useState(0);
  const busyRef = useRef(false);
  const endpoint = `/api/feedback/${encodeURIComponent(token)}`;

  useEffect(() => {
    let active = true;
    axios.get(endpoint, { headers: { "Cache-Control": "no-store" } })
      .then(({ data }) => {
        if (!active) return;
        setAppointment(data.appointment);
        setState(data.submitted ? "submitted" : "ready");
      })
      .catch(cause => {
        if (!active) return;
        setState(cause.response?.status === 404 || cause.response?.status === 410 ? "unavailable" : "error");
      });
    return () => { active = false; };
  }, [endpoint, retry]);

  const submit = async event => {
    event.preventDefault();
    if (busyRef.current || state !== "ready") return;
    if (!text.trim() || text.length > 10000) { setError("اكتب ملاحظتك، بحد أقصى 10,000 حرف."); return; }
    busyRef.current = true;
    setState("submitting");
    setError("");
    try {
      await axios.post(endpoint, { text });
      setState("submitted");
    } catch (cause) {
      if (cause.response?.status === 409 && cause.response?.data?.error === "ALREADY_SUBMITTED") setState("submitted");
      else if (cause.response?.status === 404 || cause.response?.status === 410) setState("unavailable");
      else { setState("ready"); setError("تعذر تأكيد إرسال الملاحظة. حاول مرة أخرى؛ لن تُحفظ أكثر من مرة."); }
    } finally { busyRef.current = false; }
  };

  return (
    <main dir="rtl" className="mx-auto min-h-[65vh] w-full max-w-2xl px-4 pb-16 pt-36 text-foreground">
      <section className="min-w-0 rounded-2xl border border-border bg-card p-5 shadow-sm sm:p-8">
        <div className="mb-5 inline-flex rounded-full bg-primary/10 p-3 text-primary"><MessageSquare className="h-6 w-6" aria-hidden="true" /></div>
        <h1 className="text-2xl font-semibold">كيف تشعر بعد العلاج؟</h1>
        {state === "loading" && <p role="status" className="mt-5 text-sm text-muted-foreground">جارٍ تحميل الموعد...</p>}
        {state === "unavailable" && <p role="alert" className="mt-5 text-sm leading-7 text-muted-foreground">هذا الرابط غير متاح أو انتهت صلاحيته.</p>}
        {state === "error" && <div className="mt-5"><p role="alert" className="text-sm text-destructive">تعذر تحميل الموعد. تحقق من الاتصال وحاول مرة أخرى.</p><button type="button" onClick={() => { setState("loading"); setRetry(value => value + 1); }} className="mt-4 rounded-xl bg-primary px-4 py-2 text-primary-foreground">إعادة المحاولة</button></div>}
        {state === "submitted" && <div role="status" className="mt-6 rounded-xl bg-primary/10 p-5"><CheckCircle2 className="mb-3 h-6 w-6 text-primary" aria-hidden="true" /><p className="font-semibold">شكرًا لك، تم استلام ملاحظتك.</p><p className="mt-2 text-sm leading-7 text-muted-foreground">أُرسلت ملاحظة لهذا الموعد ولا يمكن تعديلها أو إرسالها مرة أخرى.</p></div>}
        {(state === "ready" || state === "submitting") && <>
          <p className="mt-3 text-sm leading-7 text-muted-foreground">شاركنا ملاحظتك حول الجلسة لمتابعة تحسّنك. ستظهر ملاحظتك لإدارة العيادة.</p>
          <div className="mt-5 rounded-xl bg-muted/50 p-4 text-sm"><p className="break-words font-medium">{appointment?.title}</p><p className="mt-2 text-muted-foreground"><bdi>{appointment?.date} · {appointment?.time}</bdi></p></div>
          <form onSubmit={submit} className="mt-6 space-y-4">
            <label className="block space-y-2"><span className="text-sm font-medium">ملاحظتك</span><textarea required maxLength={10000} rows={8} value={text} disabled={state === "submitting"} onChange={event => { setText(event.target.value); setError(""); }} className="w-full min-w-0 resize-y rounded-xl border border-border bg-background p-4 text-sm leading-7 [overflow-wrap:anywhere] focus:outline-none focus:ring-2 focus:ring-primary/40 disabled:opacity-60" aria-describedby="feedback-help feedback-count" /></label>
            <div className="flex flex-wrap justify-between gap-2 text-xs text-muted-foreground"><p id="feedback-help">يمكن إرسال الملاحظة مرة واحدة فقط.</p><p id="feedback-count"><bdi>{text.length.toLocaleString("en-US")} / 10,000</bdi></p></div>
            {error && <p role="alert" className="rounded-xl bg-destructive/10 p-3 text-sm text-destructive">{error}</p>}
            <button type="submit" disabled={state === "submitting" || !text.trim()} className="w-full rounded-xl bg-primary px-5 py-3 font-medium text-primary-foreground hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-50">{state === "submitting" ? "جارٍ الإرسال..." : "إرسال الملاحظة"}</button>
          </form>
        </>}
      </section>
    </main>
  );
}
