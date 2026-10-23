"use client";

import { useEffect, useRef, useState } from "react";
import NeonLoader from "@/components/ui/loading";

export default function UnsubscribeClient({ token }) {
  const [phase, setPhase] = useState("loading");
  const [retry, setRetry] = useState(0);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const submitting = useRef(false);
  const endpoint = `/api/reminders/unsubscribe/${encodeURIComponent(token)}`;

  useEffect(() => {
    const controller = new AbortController();
    let active = true;
    async function load() {
      try {
        const response = await fetch(endpoint, { cache: "no-store", referrerPolicy: "no-referrer", signal: controller.signal });
        if (!active) return;
        if (response.status === 404) { setPhase("invalid"); return; }
        if (!response.ok) throw new Error("Unavailable");
        const data = await response.json();
        if (typeof data.unsubscribed !== "boolean") throw new Error("Invalid response");
        if (active) setPhase(data.unsubscribed ? "success" : "ready");
      } catch {
        if (active) setPhase("error");
      }
    }
    load();
    return () => { active = false; controller.abort(); };
  }, [endpoint, retry]);

  async function unsubscribe(event) {
    event.preventDefault();
    if (submitting.current || phase !== "ready") return;
    submitting.current = true;
    setPending(true);
    setError("");
    try {
      const response = await fetch(endpoint, { method: "POST", cache: "no-store", referrerPolicy: "no-referrer" });
      if (response.status === 404) { setPhase("invalid"); return; }
      if (!response.ok) throw new Error("Unavailable");
      const data = await response.json();
      if (data.success !== true || data.unsubscribed !== true) throw new Error("Invalid response");
      setPhase("success");
    } catch {
      setError("تعذر تأكيد إيقاف التذكيرات. حاول مرة أخرى.");
    } finally {
      submitting.current = false;
      setPending(false);
    }
  }

  return <main dir="rtl" className="flex min-h-[65vh] items-center justify-center bg-background px-4 py-12 text-foreground">
    <section aria-labelledby="unsubscribe-heading" className="w-full max-w-lg rounded-2xl border border-border bg-card p-6 shadow-sm sm:p-8">
      <p className="mb-2 text-sm text-muted-foreground">SoulClinic</p>
      <h1 id="unsubscribe-heading" className="text-2xl font-semibold">إيقاف تذكيرات العودة</h1>
      <p className="mt-3 text-sm leading-7 text-muted-foreground">يمكنك إيقاف رسائل التذكير بالعودة إلى العيادة عبر واتساب. لن تتغير رسائل تأكيد المواعيد أو تذكيرات المواعيد المحجوزة.</p>

      {phase === "loading" && <div role="status" className="mt-6">
        <span className="sr-only">جارٍ التحقق من الرابط...</span>
        <div aria-hidden="true" className="flex justify-center"><NeonLoader width={160} height={64} /></div>
      </div>}
      {phase === "success" && <p role="status" className="mt-6 rounded-xl bg-primary/10 p-4 text-sm leading-7 text-primary">تم إيقاف تذكيرات العودة. لن تصلك هذه التذكيرات بعد الآن.</p>}
      {phase === "invalid" && <p role="alert" className="mt-6 rounded-xl bg-muted p-4 text-sm leading-7">هذا الرابط غير صالح أو غير متاح. يمكنك الرد بكلمة «إيقاف» على رسالة واتساب لإيقاف تذكيرات العودة.</p>}
      {phase === "error" && <div className="mt-6 space-y-4">
        <p role="alert" className="text-sm text-destructive">تعذر التحقق من الرابط. حاول مرة أخرى.</p>
        <button type="button" onClick={() => { setPhase("loading"); setRetry(value => value + 1); }} className="min-h-11 rounded-xl bg-primary px-5 py-3 text-sm font-medium text-primary-foreground">إعادة المحاولة</button>
      </div>}
      {phase === "ready" && <form onSubmit={unsubscribe} className="mt-6 space-y-4" aria-busy={pending}>
        <p className="text-sm leading-7">اضغط للتأكيد إذا كنت ترغب في إيقاف تذكيرات العودة.</p>
        {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
        <button type="submit" disabled={pending} className="min-h-11 w-full rounded-xl bg-primary px-5 py-3 text-sm font-medium text-primary-foreground disabled:cursor-wait disabled:opacity-60">{pending ? "جارٍ إيقاف التذكيرات..." : "تأكيد إيقاف التذكيرات"}</button>
        {pending && <div aria-hidden="true" className="flex justify-center"><NeonLoader width={160} height={64} /></div>}
      </form>}
    </section>
  </main>;
}
