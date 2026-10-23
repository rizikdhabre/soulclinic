"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import axios from "axios";
import { ArrowRight, CalendarDays, MessageSquare, Phone } from "lucide-react";
import NeonLoader from "@/components/ui/loading";
import FeedbackDialog from "./FeedbackDialog";
import TreatmentPlanBuilder, { notificationMessage } from "./TreatmentPlanBuilder";
import ReturnReminderPreference from "./ReturnReminderPreference";

function FeedbackPreview({ appointment, onOpen }) {
  if (!appointment.feedback?.text) return <span className="text-sm text-muted-foreground">لا توجد ملاحظة</span>;
  return (
    <button type="button" onClick={() => onOpen(appointment)} aria-label={`عرض الملاحظة كاملة — ${appointment.title}`} className="block w-full min-w-0 rounded-lg bg-primary/5 p-3 text-right hover:bg-primary/10 focus-visible:outline focus-visible:outline-2 focus-visible:outline-primary">
      <span className="line-clamp-2 whitespace-pre-wrap text-sm leading-6 [overflow-wrap:anywhere]">{appointment.feedback.text}</span>
      <span className="mt-2 inline-flex items-center gap-1 text-xs font-medium text-primary"><MessageSquare className="h-3.5 w-3.5" aria-hidden="true" />عرض الملاحظة كاملة</span>
    </button>
  );
}

function Attendance({ attended }) {
  return <span className={`inline-block whitespace-nowrap rounded-full px-3 py-1 text-xs font-medium ${attended ? "bg-primary/10 text-primary" : "bg-muted text-muted-foreground"}`}>{attended ? "حضر" : "لم يحضر"}</span>;
}

function AppointmentHistory({ appointments, onOpen }) {
  return (
    <section aria-labelledby="past-appointments-heading" className="min-w-0 overflow-hidden rounded-2xl border border-border bg-card shadow-sm">
      <div className="flex items-center gap-2 border-b border-border p-5">
        <CalendarDays className="h-5 w-5 text-primary" aria-hidden="true" />
        <h2 id="past-appointments-heading" className="text-lg font-semibold">المواعيد السابقة</h2>
        <span className="mr-auto rounded-full bg-muted px-2.5 py-1 text-xs">{appointments.length}</span>
      </div>
      {!appointments.length ? <p className="p-6 text-sm text-muted-foreground">لا توجد مواعيد سابقة.</p> : <>
        <div className="hidden lg:block">
          <table className="w-full table-fixed text-sm">
            <thead className="bg-muted/40 text-muted-foreground"><tr>
              <th className="w-[21%] p-4 text-right font-medium">التاريخ والساعة</th>
              <th className="w-[22%] p-4 text-right font-medium">العلاج</th>
              <th className="w-[12%] p-4 text-right font-medium">السعر</th>
              <th className="w-[12%] p-4 text-right font-medium">الحضور</th>
              <th className="p-4 text-right font-medium">ملاحظة الزبون</th>
            </tr></thead>
            <tbody>{appointments.map(appointment => <tr key={appointment._id} className="border-t border-border">
              <td className="p-4 align-top"><bdi>{appointment.date}</bdi><div className="mt-1 text-muted-foreground"><bdi>{appointment.time}</bdi></div></td>
              <td className="break-words p-4 align-top font-medium">{appointment.title}</td>
              <td className="p-4 align-top"><bdi>{appointment.price} ₪</bdi></td>
              <td className="p-4 align-top"><Attendance attended={appointment.attended} /></td>
              <td className="p-4 align-top"><FeedbackPreview appointment={appointment} onOpen={onOpen} /></td>
            </tr>)}</tbody>
          </table>
        </div>
        <div className="divide-y divide-border lg:hidden">{appointments.map(appointment => <article key={appointment._id} className="min-w-0 space-y-3 p-4">
          <div className="flex items-start justify-between gap-3"><h3 className="min-w-0 break-words font-medium">{appointment.title}</h3><Attendance attended={appointment.attended} /></div>
          <div className="flex flex-wrap justify-between gap-2 text-sm text-muted-foreground"><bdi>{appointment.date} · {appointment.time}</bdi><bdi>{appointment.price} ₪</bdi></div>
          <FeedbackPreview appointment={appointment} onOpen={onOpen} />
        </article>)}</div>
      </>}
    </section>
  );
}

export default function CustomerProfileClient({ userId }) {
  const [profile, setProfile] = useState(null);
  const [error, setError] = useState("");
  const [refreshError, setRefreshError] = useState("");
  const [retry, setRetry] = useState(0);
  const [selectedFeedback, setSelectedFeedback] = useState(null);

  useEffect(() => {
    let active = true;
    axios.get(`/api/admin/users/${encodeURIComponent(userId)}`, { headers: { "Cache-Control": "no-store" } })
      .then(({ data }) => { if (active) { setProfile(data); setError(""); } })
      .catch(cause => {
        if (!active) return;
        const status = cause.response?.status;
        setError(status === 404 ? "لم يتم العثور على الزبون." : status === 401 || status === 403 ? "لا يمكن عرض الملف. سجّل الدخول بحساب الإدارة." : "تعذر تحميل ملف الزبون. حاول مرة أخرى.");
      });
    return () => { active = false; };
  }, [userId, retry]);

  const refreshAfterSave = useCallback(async () => {
    setRefreshError("");
    try {
      const { data } = await axios.get(`/api/admin/users/${encodeURIComponent(userId)}`, { headers: { "Cache-Control": "no-store" } });
      setProfile(data);
    } catch {
      setRefreshError("تعذر تحديث قائمة المواعيد. البرنامج محفوظ.");
    }
  }, [userId]);

  if (!profile && !error) return <div dir="rtl" role="status" className="flex min-h-screen items-center justify-center bg-background">
    <span className="sr-only">جارٍ تحميل ملف الزبون...</span>
    <div aria-hidden="true" className="w-full max-w-[500px] [&>canvas]:h-auto [&>canvas]:max-w-full"><NeonLoader width={500} height={200} /></div>
  </div>;

  if (!profile) return <div dir="rtl" className="mx-auto max-w-5xl rounded-2xl border border-border bg-card p-6">
    <p role="alert" className="text-sm text-destructive">{error}</p><button type="button" onClick={() => { setError(""); setRetry(value => value + 1); }} className="mt-4 rounded-xl bg-primary px-4 py-2 text-primary-foreground">إعادة المحاولة</button><Link href="/admin/users" className="mr-4 text-sm text-primary">قائمة الزبائن</Link>
  </div>;

  const past = profile.appointments.filter(appointment => appointment.isPast).sort((a, b) => `${b.date} ${b.time}`.localeCompare(`${a.date} ${a.time}`));
  const upcoming = profile.appointments.filter(appointment => !appointment.isPast).sort((a, b) => `${a.date} ${a.time}`.localeCompare(`${b.date} ${b.time}`));
  return (
    <div dir="rtl" className="mx-auto w-full min-w-0 max-w-6xl space-y-6 text-foreground">
      <Link href="/admin/users" className="inline-flex items-center gap-2 text-sm text-primary hover:underline"><ArrowRight className="h-4 w-4" aria-hidden="true" />قائمة الزبائن</Link>
      <header className="rounded-2xl border border-border bg-card p-5 shadow-sm sm:p-6">
        <p className="mb-2 text-sm text-muted-foreground">ملف الزبون</p>
        <h1 className="break-words text-2xl font-semibold">{profile.user.firstName} {profile.user.lastName}</h1>
        <p className="mt-3 flex items-center gap-2 text-sm text-muted-foreground"><Phone className="h-4 w-4" aria-hidden="true" /><bdi>{profile.user.phone}</bdi></p>
      </header>
      <ReturnReminderPreference key={userId} userId={userId} />
      <AppointmentHistory appointments={past} onOpen={setSelectedFeedback} />
      <TreatmentPlanBuilder userId={userId} customerName={`${profile.user.firstName} ${profile.user.lastName}`} onSaved={refreshAfterSave} />
      {refreshError && <div role="alert" className="rounded-xl border border-border bg-card p-4 text-sm"><p>{refreshError}</p><button type="button" onClick={refreshAfterSave} className="mt-2 text-primary underline">تحديث قائمة المواعيد</button></div>}
      {upcoming.length > 0 && <section aria-labelledby="upcoming-heading" className="rounded-2xl border border-border bg-card p-5 shadow-sm">
        <h2 id="upcoming-heading" className="text-lg font-semibold">المواعيد القادمة</h2>
        <ul className="mt-4 divide-y divide-border">{upcoming.map(appointment => <li key={appointment._id} className="flex flex-wrap items-center justify-between gap-2 py-3 text-sm"><span className="break-words font-medium">{appointment.title}</span><bdi className="text-muted-foreground">{appointment.date} · {appointment.time}</bdi></li>)}</ul>
      </section>}
      {profile.plans?.length > 0 && <section aria-labelledby="plans-heading" className="rounded-2xl border border-border bg-card p-5 shadow-sm">
        <h2 id="plans-heading" className="text-lg font-semibold">البرامج المحفوظة</h2>
        <ul className="mt-4 space-y-3">{profile.plans.map(plan => <li key={plan._id} className="rounded-xl bg-muted/40 p-3 text-sm">
          <p className="font-medium">برنامج من {plan.appointments?.length || 0} مواعيد <bdi className="font-normal text-muted-foreground">· {String(plan.createdAt).slice(0, 10)}</bdi></p>
          <p className="mt-1 text-muted-foreground">{notificationMessage(plan.notification?.status)}</p>
        </li>)}</ul>
      </section>}
      {selectedFeedback && <FeedbackDialog appointment={selectedFeedback} onClose={() => setSelectedFeedback(null)} />}
    </div>
  );
}
