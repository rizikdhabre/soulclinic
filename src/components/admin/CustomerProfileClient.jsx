"use client";

import { useCallback, useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import Link from "next/link";
import axios from "axios";
import { ArrowRight, CalendarDays, ChevronDown, ChevronLeft, ChevronRight, ChevronUp, MessageSquare, Phone, Trash2, X } from "lucide-react";
import NeonLoader from "@/components/ui/loading";
import { getWhatsAppLink } from "@/lib/phone";
import FeedbackDialog from "./FeedbackDialog";
import TreatmentPlanBuilder, { notificationMessage } from "./TreatmentPlanBuilder";
import ReturnReminderPreference from "./ReturnReminderPreference";
import TreatmentPlanComments, { getCommentSession } from "./TreatmentPlanComments";

function NotePreview({ appointment, kind = "feedback", onOpen }) {
  const isBookingNote = kind === "bookingNote";
  const text = isBookingNote ? appointment.bookingNote : appointment.feedback?.text;
  const action = isBookingNote ? "عرض ملاحظة الحجز كاملة" : "عرض تقييم العلاج كاملًا";
  if (!text) return <span className="text-sm text-muted-foreground">{isBookingNote ? "لا توجد ملاحظة حجز" : "لا يوجد تقييم للعلاج"}</span>;
  return (
    <button type="button" onClick={() => onOpen({ appointment, kind })} aria-label={`${action} — ${appointment.title}`} className="block w-full min-w-0 rounded-lg bg-primary/5 p-3 text-right hover:bg-primary/10 focus-visible:outline focus-visible:outline-2 focus-visible:outline-primary">
      <span className="line-clamp-2 whitespace-pre-wrap text-sm leading-6 [overflow-wrap:anywhere]">{text}</span>
      <span className="mt-2 inline-flex items-center gap-1 text-xs font-medium text-primary"><MessageSquare className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />{action}</span>
    </button>
  );
}

const appointmentStatuses = { upcoming: "قادم", attended: "حضر", not_attended: "لم يحضر", canceled: "ملغى", unknown: "بحاجة للتحقق" };
const planStatuses = { upcoming: "قادم", in_progress: "جارٍ", completed: "مكتمل", canceled: "ملغى", ended: "انتهى دون اكتمال العلاج", unknown: "بحاجة للتحقق" };

function StatusBadge({ status, plan = false }) {
  const labels = plan ? planStatuses : appointmentStatuses;
  const highlighted = ["upcoming", "attended", "in_progress", "completed"].includes(status);
  return <span className={`inline-block rounded-full px-3 py-1 text-xs font-medium ${highlighted ? "bg-primary/10 text-primary" : "bg-muted text-muted-foreground"}`}>{labels[status] || labels.unknown}</span>;
}

function AppointmentList({ appointments, onOpen }) {
  const [expanded, setExpanded] = useState(true);
  const [pageSize, setPageSize] = useState(5);
  const [page, setPage] = useState(0);
  const contentId = useId();
  const pageCount = Math.max(1, Math.ceil(appointments.length / pageSize));
  const currentPage = Math.min(page, pageCount - 1);
  if (page !== currentPage) setPage(currentPage);
  const start = currentPage * pageSize;
  const visible = appointments.slice(start, start + pageSize);
  return (
    <section aria-labelledby="all-appointments-heading" className="min-w-0 overflow-hidden rounded-2xl border border-border bg-card shadow-sm">
      <div className="flex items-center gap-2 border-b border-border p-5">
        <CalendarDays className="h-5 w-5 text-primary" aria-hidden="true" />
        <h2 id="all-appointments-heading" className="text-lg font-semibold">جميع المواعيد</h2>
        <span className="mr-auto rounded-full bg-muted px-2.5 py-1 text-xs">{appointments.length}</span>
        <button type="button" onClick={() => setExpanded(value => !value)} aria-expanded={expanded} aria-controls={contentId} aria-label={`${expanded ? "طي" : "توسيع"} جميع المواعيد`} className="rounded-lg p-2 hover:bg-muted">
          {expanded ? <ChevronUp className="h-5 w-5" aria-hidden="true" /> : <ChevronDown className="h-5 w-5" aria-hidden="true" />}
        </button>
      </div>
      <div id={contentId} hidden={!expanded}>
      {!appointments.length ? <p className="p-6 text-sm text-muted-foreground">لا توجد مواعيد.</p> : <>
        <div className="hidden lg:block">
          <table className="w-full table-fixed text-sm">
            <thead className="bg-muted/40 text-muted-foreground"><tr>
              <th scope="col" className="w-[17%] p-4 text-right font-medium">التاريخ والساعة</th>
              <th scope="col" className="w-[17%] p-4 text-right font-medium">العلاج</th>
              <th scope="col" className="w-[10%] p-4 text-right font-medium">السعر</th>
              <th scope="col" className="w-[14%] p-4 text-right font-medium">الحالة</th>
              <th scope="col" className="w-[21%] p-4 text-right font-medium">ملاحظة الحجز</th>
              <th scope="col" className="w-[21%] p-4 text-right font-medium">تقييم العلاج</th>
            </tr></thead>
            <tbody>{visible.map(appointment => <tr key={appointment._id} className="border-t border-border">
              <td className="p-4 align-top"><bdi>{appointment.date}</bdi><div className="mt-1 text-muted-foreground"><bdi>{appointment.time}</bdi></div></td>
              <td className="break-words p-4 align-top font-medium">{appointment.title}</td>
              <td className="p-4 align-top"><bdi>{appointment.price} ₪</bdi></td>
              <td className="p-4 align-top"><StatusBadge status={appointment.status} /></td>
              <td className="p-4 align-top"><NotePreview appointment={appointment} kind="bookingNote" onOpen={onOpen} /></td>
              <td className="p-4 align-top"><NotePreview appointment={appointment} onOpen={onOpen} /></td>
            </tr>)}</tbody>
          </table>
        </div>
        <div className="divide-y divide-border lg:hidden">{visible.map(appointment => <article key={appointment._id} className="min-w-0 space-y-3 p-4">
          <dl className="grid min-w-0 grid-cols-2 gap-3 text-sm">
            <div className="min-w-0"><dt className="mb-1 text-xs text-muted-foreground">العلاج</dt><dd className="break-words font-medium">{appointment.title}</dd></div>
            <div><dt className="mb-1 text-xs text-muted-foreground">الحالة</dt><dd><StatusBadge status={appointment.status} /></dd></div>
            <div><dt className="mb-1 text-xs text-muted-foreground">التاريخ والساعة</dt><dd><bdi>{appointment.date} · {appointment.time}</bdi></dd></div>
            <div><dt className="mb-1 text-xs text-muted-foreground">السعر</dt><dd><bdi>{appointment.price} ₪</bdi></dd></div>
            <div className="col-span-2 min-w-0"><dt className="mb-2 font-medium">ملاحظة الحجز</dt><dd><NotePreview appointment={appointment} kind="bookingNote" onOpen={onOpen} /></dd></div>
            <div className="col-span-2 min-w-0"><dt className="mb-2 font-medium">تقييم العلاج</dt><dd><NotePreview appointment={appointment} onOpen={onOpen} /></dd></div>
          </dl>
        </article>)}</div>
        <div className="flex flex-wrap items-center justify-between gap-3 border-t border-border p-4 text-sm">
          <label className="flex items-center gap-2">عدد المواعيد في الصفحة
            <select value={pageSize} onChange={event => { setPageSize(Number(event.target.value)); setPage(0); }} className="rounded-lg border border-border bg-background px-3 py-2">
              {[5, 10, 15].map(size => <option key={size} value={size}>{size}</option>)}
            </select>
          </label>
          <p className="text-xs text-muted-foreground">عرض {start + 1}–{start + visible.length} من {appointments.length} موعدًا</p>
          <div className="flex items-center gap-2">
            <button type="button" aria-label="الصفحة السابقة" disabled={currentPage === 0} onClick={() => setPage(currentPage - 1)} className="rounded-lg border border-border p-2 hover:bg-muted disabled:cursor-not-allowed disabled:opacity-40"><ChevronRight className="h-4 w-4" aria-hidden="true" /></button>
            <span className="text-xs">الصفحة {currentPage + 1} من {pageCount}</span>
            <button type="button" aria-label="الصفحة التالية" disabled={currentPage === pageCount - 1} onClick={() => setPage(currentPage + 1)} className="rounded-lg border border-border p-2 hover:bg-muted disabled:cursor-not-allowed disabled:opacity-40"><ChevronLeft className="h-4 w-4" aria-hidden="true" /></button>
          </div>
        </div>
      </>}
      </div>
    </section>
  );
}

function canDeletePlan(plan) {
  return plan.status === "canceled" && plan.counts?.total > 0 && plan.counts.canceled === plan.counts.total;
}

function SavedPlans({ userId, commentSessions, plans, pagination, loading, error, onLoadMore, onDelete, deleting, deleteError }) {
  const [expanded, setExpanded] = useState(true);
  const contentId = useId();
  return <section aria-labelledby="plans-heading" aria-busy={loading || deleting} className="min-w-0 rounded-2xl border border-border bg-card p-5 shadow-sm">
    <div className="flex items-center gap-2">
      <h2 id="plans-heading" className="text-lg font-semibold">البرامج المحفوظة</h2>
      <span className="mr-auto rounded-full bg-muted px-2.5 py-1 text-xs">{plans.length}</span>
      <button type="button" onClick={() => setExpanded(value => !value)} aria-expanded={expanded} aria-controls={contentId} aria-label={`${expanded ? "طي" : "توسيع"} البرامج المحفوظة`} className="rounded-lg p-2 hover:bg-muted">
        {expanded ? <ChevronUp className="h-5 w-5" aria-hidden="true" /> : <ChevronDown className="h-5 w-5" aria-hidden="true" />}
      </button>
    </div>
    <div id={contentId} hidden={!expanded}>
    {!plans.length && <p className="mt-4 text-sm text-muted-foreground">لا توجد برامج محفوظة.</p>}
    <div className="mt-4 space-y-4">{plans.map(plan => <article key={plan._id} className="min-w-0 rounded-xl border border-border p-4 text-sm">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div><h3 className="font-medium">برنامج من {plan.counts?.total ?? plan.appointments?.length ?? 0} مواعيد</h3><p className="mt-1 text-xs text-muted-foreground">تاريخ الإنشاء: <bdi>{String(plan.createdAt).slice(0, 10)}</bdi></p></div>
        <StatusBadge status={plan.status} plan />
        {canDeletePlan(plan) && <button type="button" onClick={() => onDelete(plan)} disabled={deleting} aria-label={`حذف البرنامج الملغى — ${String(plan.createdAt).slice(0, 10)}`} className="rounded-lg p-2 text-destructive hover:bg-destructive/10 disabled:cursor-not-allowed disabled:opacity-40"><Trash2 className="h-4 w-4" aria-hidden="true" /></button>}
      </div>
      {plan.counts && <dl className="mt-3 flex flex-wrap gap-x-4 gap-y-2 text-xs text-muted-foreground">
        {[["total", "الإجمالي"], ["upcoming", "قادمة"], ["attended", "حضر"], ["notAttended", "لم يحضر"], ["canceled", "ملغاة"], ["unknown", "بحاجة للتحقق"]].map(([key, label]) => <div key={key} className="flex gap-1"><dt>{label}: </dt><dd>{plan.counts[key] ?? 0}</dd></div>)}
      </dl>}
      <p className="mt-3 text-xs leading-6 text-muted-foreground">{notificationMessage(plan.notification?.status)}</p>
      <ul className="mt-3 divide-y divide-border border-t border-border">{plan.appointments?.map(appointment => <li key={appointment._id} className="min-w-0 py-3 last:pb-0">
        <div className="flex flex-wrap items-start justify-between gap-2"><p className="min-w-0 break-words font-medium">{appointment.title}</p><StatusBadge status={appointment.status} /></div>
        <dl className="mt-2 flex flex-wrap gap-x-5 gap-y-2 text-xs text-muted-foreground">
          <div><dt className="inline">التاريخ: </dt><dd className="inline"><bdi>{appointment.date}</bdi></dd></div>
          <div><dt className="inline">الساعة: </dt><dd className="inline"><bdi>{appointment.time}</bdi></dd></div>
          <div><dt className="inline">السعر: </dt><dd className="inline"><bdi>{appointment.price} ₪</bdi></dd></div>
        </dl>
      </li>)}</ul>
      <TreatmentPlanComments userId={userId} plan={plan} session={getCommentSession(commentSessions, plan)} />
      {deleteError?.planId === plan._id && <p role="alert" className="mt-3 text-sm text-destructive">{deleteError.text}</p>}
    </article>)}</div>
    {error && <p role="alert" className="mt-4 text-sm text-destructive">{error}</p>}
    {pagination?.hasMore && pagination.nextCursor && <button type="button" onClick={onLoadMore} disabled={loading || deleting} className="mt-4 rounded-full border border-border px-5 py-2 text-sm font-medium transition hover:bg-muted disabled:cursor-not-allowed disabled:opacity-60">
      {loading ? "جارٍ تحميل البرامج..." : error ? "إعادة المحاولة" : "عرض المزيد"}
    </button>}
    </div>
  </section>;
}

function DeletePlanDialog({ plan, pending, error, onClose, onConfirm }) {
  const dialogRef = useRef(null);
  const cancelRef = useRef(null);
  const titleId = useId();
  const descriptionId = useId();
  useEffect(() => {
    const previousFocus = document.activeElement;
    const previousOverflow = document.body.style.overflow;
    const dialog = dialogRef.current;
    document.body.style.overflow = "hidden";
    dialog.showModal();
    cancelRef.current?.focus();
    return () => {
      dialog.close();
      document.body.style.overflow = previousOverflow;
      if (previousFocus?.isConnected) previousFocus.focus();
    };
  }, []);
  return createPortal(<dialog ref={dialogRef} dir="rtl" aria-labelledby={titleId} aria-describedby={descriptionId} aria-modal="true"
    onCancel={event => { event.preventDefault(); onClose(); }}
    onClick={event => {
      if (event.target !== event.currentTarget) return;
      const bounds = event.currentTarget.getBoundingClientRect();
      if (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom) onClose();
    }}
    className="m-auto w-[calc(100%-2rem)] max-w-lg rounded-2xl border border-border bg-card p-5 text-foreground shadow-xl backdrop:bg-black/50">
    <div className="flex items-center justify-between gap-3"><h2 id={titleId} className="text-lg font-semibold">حذف البرنامج الملغى</h2><button type="button" onClick={onClose} aria-label="إغلاق" className="rounded-lg p-2 hover:bg-muted"><X className="h-5 w-5" aria-hidden="true" /></button></div>
    <p className="mt-3 text-sm text-muted-foreground">برنامج بتاريخ <bdi>{String(plan.createdAt).slice(0, 10)}</bdi> · {plan.counts.total} مواعيد ملغاة</p>
    <p id={descriptionId} className="mt-3 text-sm leading-7">هل تريد حذف هذا البرنامج الملغى نهائيًا؟ ستُزال تفاصيله والمواعيد الملغاة المسترجعة منه من الملف.</p>
    {error && <p role="alert" className="mt-3 text-sm text-destructive">{error}</p>}
    <div className="mt-5 flex flex-wrap gap-3"><button ref={cancelRef} type="button" onClick={onClose} className="rounded-xl border border-border px-4 py-2 text-sm hover:bg-muted">إلغاء</button><button type="button" onClick={onConfirm} disabled={pending} className="rounded-xl bg-destructive px-4 py-2 text-sm text-white disabled:cursor-not-allowed disabled:opacity-60">{pending ? "جارٍ الحذف..." : "تأكيد الحذف"}</button></div>
  </dialog>, document.body);
}

function CustomerProfileContent({ userId }) {
  const [profile, setProfile] = useState(null);
  const [error, setError] = useState("");
  const [refreshError, setRefreshError] = useState("");
  const [retry, setRetry] = useState(0);
  const [selectedNote, setSelectedNote] = useState(null);
  const [plansLoading, setPlansLoading] = useState(false);
  const [plansError, setPlansError] = useState("");
  const [selectedDelete, setSelectedDelete] = useState(null);
  const [deletePending, setDeletePending] = useState(false);
  const [deleteError, setDeleteError] = useState(null);
  const [deleteNotice, setDeleteNotice] = useState("");
  const [refreshReason, setRefreshReason] = useState("save");
  const profileVersion = useRef(null);
  const plansRequestPending = useRef(false);
  const deleteRequest = useRef(null);
  const commentSessions = useRef(new Map());

  useEffect(() => {
    const version = Symbol();
    profileVersion.current = version;
    axios.get(`/api/admin/users/${encodeURIComponent(userId)}`, { headers: { "Cache-Control": "no-store" } })
      .then(({ data }) => { if (profileVersion.current === version) { setProfile(data); setError(""); } })
      .catch(cause => {
        if (profileVersion.current !== version) return;
        const status = cause.response?.status;
        setError(status === 404 ? "لم يتم العثور على الزبون." : status === 401 || status === 403 ? "لا يمكن عرض الملف. سجّل الدخول بحساب الإدارة." : "تعذر تحميل ملف الزبون. حاول مرة أخرى.");
      });
    const sessions = commentSessions.current;
    return () => {
      profileVersion.current = null;
      plansRequestPending.current = false;
      deleteRequest.current = null;
      sessions.forEach(session => session.dispose());
      sessions.clear();
    };
  }, [userId, retry]);

  const refreshProfile = useCallback(async (reason = "save") => {
    if (!profileVersion.current) return;
    // A fresh profile replaces the visible page and invalidates any older page request.
    const version = Symbol();
    profileVersion.current = version;
    plansRequestPending.current = true;
    setPlansLoading(true);
    setPlansError("");
    setRefreshError("");
    setRefreshReason(reason);
    try {
      const { data } = await axios.get(`/api/admin/users/${encodeURIComponent(userId)}`, { headers: { "Cache-Control": "no-store" } });
      if (profileVersion.current === version) setProfile(data);
    } catch {
      if (profileVersion.current === version) setRefreshError(reason === "delete" ? "تم حذف البرنامج، لكن تعذر تحديث الملف. أعد التحديث." : "تعذر تحديث قائمة المواعيد. البرنامج محفوظ.");
    } finally {
      if (profileVersion.current === version) {
        plansRequestPending.current = false;
        setPlansLoading(false);
      }
    }
  }, [userId]);
  const refreshAfterSave = useCallback(() => refreshProfile("save"), [refreshProfile]);

  const deletePlan = async () => {
    const plan = selectedDelete;
    if (!profileVersion.current || deleteRequest.current || !plan || !canDeletePlan(plan)) return;
    const request = Symbol();
    // Keep pending reads valid if DELETE fails; the success refresh invalidates them.
    deleteRequest.current = request;
    setPlansError("");
    setDeletePending(true);
    setDeleteError(null);
    setDeleteNotice("");
    try {
      await axios.delete(`/api/admin/users/${encodeURIComponent(userId)}/treatment-plans/${encodeURIComponent(plan._id)}`);
      if (deleteRequest.current !== request || !profileVersion.current) return;
      commentSessions.current.get(plan._id)?.dispose();
      commentSessions.current.delete(plan._id);
      const removedAppointmentIds = new Set(plan.appointments.map(appointment => appointment._id));
      setProfile(current => ({
        ...current,
        plans: current.plans.filter(item => item._id !== plan._id),
        appointments: current.appointments.filter(appointment => !removedAppointmentIds.has(appointment._id)),
        plansPagination: { hasMore: false, nextCursor: null },
      }));
      setSelectedDelete(null);
      setDeleteNotice("تم حذف البرنامج الملغى بنجاح.");
      await refreshProfile("delete");
    } catch (cause) {
      if (deleteRequest.current !== request || !profileVersion.current) return;
      setDeleteError({ planId: plan._id, text: cause.response?.status === 409 ? "تغير البرنامج أو توجد مواعيد غير ملغاة. حدّث الملف قبل المحاولة مجددًا." : "تعذر حذف البرنامج. حاول مرة أخرى." });
    } finally {
      if (deleteRequest.current === request) {
        deleteRequest.current = null;
        setDeletePending(false);
      }
    }
  };

  const loadMorePlans = async () => {
    const pagination = profile?.plansPagination;
    const version = profileVersion.current;
    if (!version || plansRequestPending.current || deleteRequest.current || !pagination?.hasMore || !pagination.nextCursor) return;
    plansRequestPending.current = true;
    setPlansLoading(true);
    setPlansError("");
    try {
      const { data } = await axios.get(`/api/admin/users/${encodeURIComponent(userId)}/treatment-plans`, {
        params: { cursor: pagination.nextCursor }, headers: { "Cache-Control": "no-store" },
      });
      if (profileVersion.current !== version) return;
      setProfile(current => {
        if (profileVersion.current !== version) return current;
        const seen = new Set(current.plans.map(plan => plan._id));
        const added = data.plans.filter(plan => {
          if (seen.has(plan._id)) return false;
          seen.add(plan._id);
          return true;
        });
        return { ...current, plans: [...current.plans, ...added], plansPagination: data.plansPagination };
      });
    } catch {
      if (profileVersion.current === version) setPlansError("تعذر تحميل المزيد من البرامج. حاول مرة أخرى.");
    } finally {
      if (profileVersion.current === version) {
        plansRequestPending.current = false;
        setPlansLoading(false);
      }
    }
  };

  if (!profile && !error) return <div dir="rtl" role="status" className="flex min-h-screen items-center justify-center bg-background">
    <span className="sr-only">جارٍ تحميل ملف الزبون...</span>
    <div aria-hidden="true" className="w-full max-w-[500px] [&>canvas]:h-auto [&>canvas]:max-w-full"><NeonLoader width={500} height={200} /></div>
  </div>;

  if (!profile) return <div dir="rtl" className="mx-auto max-w-5xl rounded-2xl border border-border bg-card p-6">
    <p role="alert" className="text-sm text-destructive">{error}</p><button type="button" onClick={() => { setError(""); setRetry(value => value + 1); }} className="mt-4 rounded-xl bg-primary px-4 py-2 text-primary-foreground">إعادة المحاولة</button><Link href="/admin/users" className="mr-4 text-sm text-primary">قائمة الزبائن</Link>
  </div>;

  const appointments = [...profile.appointments].sort((a, b) => `${b.date} ${b.time}`.localeCompare(`${a.date} ${a.time}`));
  return (
    <div dir="rtl" className="mx-auto w-full min-w-0 max-w-6xl space-y-6 text-foreground">
      <Link href="/admin/users" className="mr-8 inline-flex items-center gap-2 text-sm text-primary hover:underline md:mr-0"><ArrowRight className="h-4 w-4" aria-hidden="true" />قائمة الزبائن</Link>
      <header className="rounded-2xl border border-border bg-card p-5 shadow-sm sm:p-6">
        <p className="mb-2 text-sm text-muted-foreground">ملف الزبون</p>
        <h1 className="break-words text-2xl font-semibold">{profile.user.firstName} {profile.user.lastName}</h1>
        <p className="mt-3 flex items-center gap-2 text-sm text-muted-foreground"><Phone className="h-4 w-4" aria-hidden="true" /><bdi>{profile.user.phone}</bdi></p>
        <div className="mt-4 flex flex-wrap gap-2">
          <a href={`tel:${profile.user.phone}`} className="inline-flex items-center justify-center rounded-full border px-4 py-1.5 text-sm font-medium transition hover:bg-muted">اتصال</a>
          <a href={getWhatsAppLink(profile.user.phone)} target="_blank" rel="noreferrer" className="inline-flex items-center justify-center rounded-full border px-4 py-1.5 text-sm font-medium text-green-600 transition hover:bg-green-50">واتساب</a>
        </div>
      </header>
      <ReturnReminderPreference key={userId} userId={userId} />
      <AppointmentList appointments={appointments} onOpen={setSelectedNote} />
      <TreatmentPlanBuilder userId={userId} customerName={`${profile.user.firstName} ${profile.user.lastName}`} onSaved={refreshAfterSave} />
      {deleteNotice && <p role="status" className="rounded-xl border border-border bg-card p-4 text-sm">{deleteNotice}</p>}
      {refreshError && <div role="alert" className="rounded-xl border border-border bg-card p-4 text-sm"><p>{refreshError}</p><button type="button" onClick={() => refreshProfile(refreshReason)} className="mt-2 text-primary underline">تحديث قائمة المواعيد</button></div>}
      <SavedPlans userId={userId} commentSessions={commentSessions.current} plans={profile.plans || []} pagination={profile.plansPagination} loading={plansLoading} error={plansError} onLoadMore={loadMorePlans} onDelete={plan => { setSelectedDelete(plan); setDeleteError(null); }} deleting={deletePending} deleteError={deleteError} />
      {selectedNote && <FeedbackDialog appointment={selectedNote.appointment} kind={selectedNote.kind} onClose={() => setSelectedNote(null)} />}
      {selectedDelete && <DeletePlanDialog plan={selectedDelete} pending={deletePending} error={deleteError?.planId === selectedDelete._id ? deleteError.text : ""} onClose={() => setSelectedDelete(null)} onConfirm={deletePlan} />}
    </div>
  );
}

export default function CustomerProfileClient({ userId }) {
  return <CustomerProfileContent key={userId} userId={userId} />;
}
