"use client";

import { useEffect, useRef, useState } from "react";
import NeonLoader from "@/components/ui/loading";

export default function ReturnReminderPreference({ userId }) {
  const [enabled, setEnabled] = useState(null);
  const [consentConfirmed, setConsentConfirmed] = useState(false);
  const [loadError, setLoadError] = useState("");
  const [saveError, setSaveError] = useState("");
  const [retry, setRetry] = useState(0);
  const [pending, setPending] = useState(false);
  const saving = useRef(false);
  const endpoint = `/api/admin/users/${encodeURIComponent(userId)}/return-reminders`;

  useEffect(() => {
    const controller = new AbortController();
    let active = true;
    async function load() {
      try {
        const response = await fetch(endpoint, { cache: "no-store", signal: controller.signal });
        if (!response.ok) throw new Error("Unavailable");
        const data = await response.json();
        if (typeof data.enabled !== "boolean") throw new Error("Invalid response");
        if (active) { setEnabled(data.enabled); setLoadError(""); }
      } catch {
        if (active) setLoadError("تعذر تحميل إعداد تذكيرات العودة. حاول مرة أخرى.");
      }
    }
    load();
    return () => { active = false; controller.abort(); };
  }, [endpoint, retry]);

  async function save(nextEnabled) {
    if (saving.current || enabled === null || nextEnabled && !consentConfirmed) return;
    saving.current = true;
    setPending(true);
    setSaveError("");
    try {
      const response = await fetch(endpoint, {
        method: "PATCH", cache: "no-store", headers: { "Content-Type": "application/json" },
        body: JSON.stringify(nextEnabled ? { enabled: true, consentConfirmed: true } : { enabled: false }),
      });
      if (!response.ok) throw new Error("Unavailable");
      const data = await response.json();
      if (typeof data.enabled !== "boolean") throw new Error("Invalid response");
      setEnabled(data.enabled);
      setConsentConfirmed(false);
    } catch {
      setSaveError("تعذر تأكيد حفظ الإعداد. حاول مرة أخرى.");
    } finally {
      saving.current = false;
      setPending(false);
    }
  }

  return <section dir="rtl" aria-labelledby="return-reminder-heading" className="rounded-2xl border border-border bg-card p-5 shadow-sm sm:p-6">
    <h2 id="return-reminder-heading" className="text-lg font-semibold">موافقة الزبون على تذكيرات العودة</h2>
    <p className="mt-2 text-sm leading-7 text-muted-foreground">تسمح الموافقة بتذكير عبر واتساب بعد مرور ثلاثة أشهر دون زيارة، ثم مرة كل 30 يومًا ما دام لا يوجد موعد قادم. لا يغيّر هذا الإذن رسائل المواعيد.</p>
    {enabled === null && !loadError && <div role="status" className="mt-3">
      <span className="sr-only">جارٍ تحميل إعداد التذكيرات...</span>
      <div aria-hidden="true"><NeonLoader width={160} height={64} /></div>
    </div>}
    {loadError && <div className="mt-4 space-y-3">
      <p role="alert" className="text-sm text-destructive">{loadError}</p>
      <button type="button" onClick={() => { setLoadError(""); setRetry(value => value + 1); }} className="min-h-11 rounded-xl border border-border px-4 py-2 text-sm text-primary">إعادة المحاولة</button>
    </div>}
    {enabled !== null && <div className="mt-4 space-y-4" aria-busy={pending}>
      <p role="status" className={`text-sm font-medium ${enabled ? "text-primary" : "text-muted-foreground"}`}>{enabled ? "موافقة الزبون مسجّلة لتلقي تذكيرات العودة." : "تذكيرات العودة متوقفة لهذا الرقم."}</p>
      {!enabled && <label className="flex items-start gap-3 text-sm leading-7">
        <input type="checkbox" checked={consentConfirmed} disabled={pending} onChange={event => setConsentConfirmed(event.target.checked)} className="mt-1.5 h-4 w-4 shrink-0 accent-primary" />
        <span>أؤكد أن الزبون وافق صراحةً على تلقي تذكيرات العودة عبر واتساب.</span>
      </label>}
      {saveError && <p role="alert" className="text-sm text-destructive">{saveError}</p>}
      <button type="button" disabled={pending || !enabled && !consentConfirmed} onClick={() => save(!enabled)} className="min-h-11 rounded-xl bg-primary px-4 py-2 text-sm font-medium text-primary-foreground disabled:cursor-not-allowed disabled:opacity-50">{pending ? "جارٍ حفظ الإعداد..." : enabled ? "إيقاف تذكيرات العودة" : "تسجيل موافقة الزبون"}</button>
      {pending && <div aria-hidden="true"><NeonLoader width={160} height={64} /></div>}
    </div>}
  </section>;
}
