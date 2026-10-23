"use client";

import { useEffect, useId, useSyncExternalStore } from "react";
import axios from "axios";
import { Check, Pencil, Trash2, X } from "lucide-react";

function IconButton({ label, children, ...props }) {
  return <button type="button" aria-label={label} title={label} {...props} className="shrink-0 rounded-lg p-2 text-muted-foreground hover:bg-muted hover:text-foreground disabled:cursor-not-allowed disabled:opacity-40">{children}</button>;
}

function commentError(cause, adding) {
  const code = cause.response?.data?.error;
  if (code === "PLAN_NOT_FOUND") return { text: "لم يعد هذا البرنامج متاحًا. تعذر حفظ التغيير.", unavailable: true };
  if (["COMMENT_CONFLICT", "COMMENT_ID_REUSED", "COMMENT_NOT_FOUND"].includes(code)) return { text: "تغيّر التعليق أو حُذف لدى مسؤول آخر. حدّث التعليقات وراجعها قبل المحاولة مجددًا.", refresh: true };
  if (code === "COMMENT_LIMIT_REACHED") return { text: "وصل البرنامج إلى الحد الأقصى: 100 تعليق. حدّث التعليقات قبل المحاولة مجددًا.", refresh: true };
  if (code === "INVALID_COMMENT_TEXT") return { text: "أدخل تعليقًا غير فارغ لا يتجاوز 10000 حرف." };
  if ([401, 403].includes(cause.response?.status)) return { text: "تعذر حفظ التعليق. سجّل الدخول بحساب الإدارة." };
  return { text: adding ? "تعذر تأكيد إضافة التعليق. أعد المحاولة للتحقق من حفظه." : "تعذر حفظ التغيير. حاول مرة أخرى." };
}

// The profile owns these sessions so paging can temporarily unmount a card
// without discarding its draft, pending request, or retry identity.
export function getCommentSession(sessions, plan) {
  if (sessions.has(plan._id)) return sessions.get(plan._id);
  let snapshot = {
    confirmed: { comments: plan.comments || [], commentsVersion: plan.commentsVersion || 0 },
    draft: "", edit: null, deleting: null, pending: false, error: null, notice: "", addAttempt: null,
  };
  const listeners = new Set();
  const session = {
    active: true,
    getSnapshot: () => snapshot,
    subscribe: listener => { listeners.add(listener); return () => listeners.delete(listener); },
    update: change => {
      if (!session.active) return;
      snapshot = { ...snapshot, ...(typeof change === "function" ? change(snapshot) : change) };
      listeners.forEach(listener => listener());
    },
    dispose: () => { session.active = false; listeners.clear(); },
  };
  sessions.set(plan._id, session);
  return session;
}

function newestComments(current, incoming) {
  return incoming.commentsVersion >= current.commentsVersion ? { comments: incoming.comments || [], commentsVersion: incoming.commentsVersion } : current;
}

export default function TreatmentPlanComments({ userId, plan, session }) {
  const { confirmed, draft, edit, deleting, pending, error, notice, addAttempt } = useSyncExternalStore(session.subscribe, session.getSnapshot, session.getSnapshot);
  const draftId = useId();
  const editId = useId();
  const base = `/api/admin/users/${encodeURIComponent(userId)}/treatment-plans/${encodeURIComponent(plan._id)}/comments`;

  // Parent profile requests may have begun before a comment was saved.
  useEffect(() => {
    if ((plan.commentsVersion || 0) > session.getSnapshot().confirmed.commentsVersion) {
      session.update(current => ({ confirmed: newestComments(current.confirmed, plan) }));
    }
  }, [plan, session]);

  const blocked = pending || Boolean(error?.refresh || error?.unavailable);
  const mutate = async (method, comment = null) => {
    if (!session.active || session.getSnapshot().pending || blocked) return;
    if (method === "POST" && !draft.trim()) return;
    if (method === "PATCH" && (!edit?.text.trim() || !edit.revision)) return;
    if (method === "DELETE" && !comment?.revision) return;
    session.update({ pending: true, error: null, notice: "" });
    try {
      let response;
      if (method === "POST") {
        if (!session.getSnapshot().addAttempt) session.update({ addAttempt: { commentId: crypto.randomUUID(), text: draft } });
        response = await axios.post(base, session.getSnapshot().addAttempt);
      } else if (method === "PATCH") {
        response = await axios.patch(`${base}/${encodeURIComponent(edit._id)}`, { text: edit.text, revision: edit.revision });
      } else {
        response = await axios.delete(`${base}/${encodeURIComponent(comment._id)}`, { data: { revision: comment.revision } });
      }
      session.update(current => ({
        confirmed: newestComments(current.confirmed, response.data),
        ...(method === "POST" ? { addAttempt: null, draft: "" } : method === "PATCH" ? { edit: null } : { deleting: null }),
      }));
    } catch (cause) {
      session.update({
        error: commentError(cause, method === "POST"),
        ...(method === "POST" && cause.response?.status < 500 ? { addAttempt: null } : {}),
      });
    } finally {
      session.update({ pending: false });
    }
  };

  const refresh = async () => {
    if (!session.active || session.getSnapshot().pending) return;
    session.update({ pending: true });
    try {
      const { data } = await axios.get(base, { headers: { "Cache-Control": "no-store" } });
      session.update(current => {
        const accepted = newestComments(current.confirmed, data);
        return {
          confirmed: accepted,
          edit: current.edit ? { ...current.edit, revision: accepted.comments.find(comment => comment._id === current.edit._id)?.revision || null } : null,
          deleting: current.deleting ? accepted.comments.find(comment => comment._id === current.deleting._id) || null : null,
          error: null,
          notice: "تم تحديث التعليقات. راجع أحدث نص قبل حفظ تعديلاتك.",
        };
      });
    } catch (cause) {
      session.update({ error: { ...commentError(cause, false), refresh: cause.response?.data?.error !== "PLAN_NOT_FOUND" } });
    } finally {
      session.update({ pending: false });
    }
  };

  return <section aria-label="تعليقات الإدارة" aria-busy={pending} className="mt-4 min-w-0 border-t border-border pt-4">
    <h4 className="text-xs font-medium text-muted-foreground">تعليقات الإدارة <span className="font-normal">· خاصة</span></h4>
    <div className="mt-3 space-y-3">{confirmed.comments.map((comment, index) => <div key={comment._id} className="min-w-0 rounded-lg bg-muted/40 p-3">
      <div className="flex items-start gap-2">
        <p className="min-w-0 flex-1 whitespace-pre-wrap text-sm leading-7 [overflow-wrap:anywhere]">{comment.text}</p>
        <div className="flex shrink-0 flex-col sm:flex-row">
          <IconButton label={`تعديل التعليق ${index + 1}`} disabled={blocked} onClick={() => session.update({ edit: { ...comment }, deleting: null, error: null, notice: "" })}><Pencil className="h-4 w-4" aria-hidden="true" /></IconButton>
          <IconButton label={`حذف التعليق ${index + 1}`} disabled={blocked} onClick={() => session.update({ deleting: comment, edit: null, error: null, notice: "" })}><Trash2 className="h-4 w-4" aria-hidden="true" /></IconButton>
        </div>
      </div>
    </div>)}</div>
    {edit && <div className="mt-3 min-w-0">
      <label htmlFor={editId} className="mb-2 block text-xs text-muted-foreground">تعديل التعليق</label>
      <textarea id={editId} value={edit.text} onChange={event => session.update({ edit: { ...edit, text: event.target.value } })} disabled={pending} maxLength={10000} rows={4} className="w-full min-w-0 resize-y rounded-lg border border-border bg-background p-3 text-sm leading-7 [overflow-wrap:anywhere] disabled:opacity-60" />
      {!edit.revision && <p className="mt-2 text-xs text-destructive">حُذف هذا التعليق. مسودتك ما زالت ظاهرة لنسخها.</p>}
      <div className="mt-1 flex gap-1"><IconButton label="حفظ تعديلات التعليق" disabled={blocked || !edit.text.trim() || !edit.revision} onClick={() => mutate("PATCH")}><Check className="h-4 w-4" aria-hidden="true" /></IconButton><IconButton label="إلغاء التعديل" disabled={pending} onClick={() => session.update({ edit: null })}><X className="h-4 w-4" aria-hidden="true" /></IconButton></div>
    </div>}
    {deleting && <div className="mt-3 flex flex-wrap items-center gap-2 rounded-lg border border-border p-3">
      <p className="text-xs">حذف هذا التعليق نهائيًا؟</p>
      <IconButton label="تأكيد حذف التعليق" disabled={blocked} onClick={() => mutate("DELETE", deleting)}><Check className="h-4 w-4" aria-hidden="true" /></IconButton>
      <IconButton label="إلغاء حذف التعليق" disabled={pending} onClick={() => session.update({ deleting: null })}><X className="h-4 w-4" aria-hidden="true" /></IconButton>
    </div>}
    <div className="mt-3 min-w-0">
      <label htmlFor={draftId} className="mb-2 block text-xs text-muted-foreground">تعليق جديد</label>
      <textarea id={draftId} value={draft} onChange={event => session.update({ draft: event.target.value })} disabled={pending || Boolean(addAttempt)} maxLength={10000} rows={3} className="w-full min-w-0 resize-y rounded-lg border border-border bg-background p-3 text-sm leading-7 [overflow-wrap:anywhere] disabled:opacity-60" />
      <button type="button" onClick={() => mutate("POST")} disabled={blocked || !draft.trim() || (confirmed.comments.length >= 100 && !addAttempt)} className="mt-2 rounded-lg border border-border px-3 py-2 text-xs font-medium hover:bg-muted disabled:cursor-not-allowed disabled:opacity-50">إضافة تعليق</button>
      {confirmed.comments.length >= 100 && <p className="mt-2 text-xs text-muted-foreground">الحد الأقصى 100 تعليق لكل برنامج.</p>}
    </div>
    {error && <div className="mt-3"><p role="alert" className="text-sm text-destructive">{error.text}</p>{error.refresh && <button type="button" disabled={pending} onClick={refresh} className="mt-2 text-xs text-primary underline disabled:opacity-50">تحديث التعليقات</button>}</div>}
    {notice && <p role="status" className="mt-3 text-xs text-muted-foreground">{notice}</p>}
  </section>;
}
