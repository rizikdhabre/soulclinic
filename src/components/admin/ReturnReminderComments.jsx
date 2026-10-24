"use client";

import { useEffect, useId, useRef, useState } from "react";
import { Check, LockKeyhole, Pencil, Plus, Trash2, X } from "lucide-react";
import NeonLoader from "@/components/ui/loading";

const buttonClass = "inline-flex min-h-11 items-center justify-center gap-2 rounded-xl border border-border px-3 py-2 text-sm hover:bg-muted disabled:cursor-not-allowed disabled:opacity-50";
const inputClass = "w-full min-w-0 resize-y rounded-xl border border-border bg-background p-3 text-base leading-7 [overflow-wrap:anywhere] disabled:opacity-60";

function IconButton({ label, children, ...props }) {
  return <button type="button" aria-label={label} title={label} {...props} className="flex h-11 w-11 shrink-0 items-center justify-center rounded-lg text-muted-foreground hover:bg-muted disabled:cursor-not-allowed disabled:opacity-50">{children}</button>;
}

function parseComments(data) {
  if (!Array.isArray(data.comments) || !Number.isSafeInteger(data.commentsVersion) || data.commentsVersion < 0 || data.comments.some(comment => typeof comment?._id !== "string" || typeof comment.text !== "string" || !Number.isSafeInteger(comment.revision) || comment.revision < 1)) throw new Error("Invalid comments");
  return { comments: data.comments, commentsVersion: data.commentsVersion };
}

function newest(current, incoming) {
  return !current || incoming.commentsVersion >= current.commentsVersion ? incoming : current;
}

export default function ReturnReminderComments({ userId }) {
  return <CommentsSession key={userId} userId={userId} />;
}

function CommentsSession({ userId }) {
  const [confirmed, setConfirmed] = useState(null);
  const [draft, setDraft] = useState("");
  const [edit, setEdit] = useState(null);
  const [deleting, setDeleting] = useState(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState(null);
  const [notice, setNotice] = useState("");
  const [addAttempt, setAddAttempt] = useState(null);
  const busy = useRef(false);
  const active = useRef(false);
  const editField = useRef(null);
  const id = useId();
  const base = `/api/admin/users/${encodeURIComponent(userId)}/return-reminders/comments`;

  useEffect(() => {
    active.current = true;
    const controller = new AbortController();
    let current = true;
    async function load() {
      try {
        const response = await fetch(base, { cache: "no-store", signal: controller.signal });
        if (!response.ok) throw new Error("Unavailable");
        const data = parseComments(await response.json());
        if (current) setConfirmed(previous => newest(previous, data));
      } catch {
        if (current) setError({ text: "تعذر تحميل التعليقات. حاول مرة أخرى.", refresh: true });
      }
    }
    load();
    return () => { current = false; active.current = false; controller.abort(); };
  }, [base]);

  useEffect(() => { if (edit?._id) editField.current?.focus(); }, [edit?._id]);

  const blocked = pending || !confirmed || Boolean(error?.refresh);

  async function mutate(method, comment) {
    if (busy.current || blocked || method === "POST" && !draft.trim() || method === "PATCH" && (!edit?.text.trim() || !edit.revision) || method === "DELETE" && !comment?.revision) return;
    busy.current = true; setPending(true); setError(null); setNotice("");
    let status;
    try {
      const attempt = method === "POST" ? addAttempt || { commentId: crypto.randomUUID(), text: draft.trim() } : null;
      if (attempt) setAddAttempt(attempt);
      const payload = attempt || (method === "PATCH" ? { text: edit.text.trim(), revision: edit.revision } : { revision: comment.revision });
      const target = method === "POST" ? base : `${base}/${encodeURIComponent(method === "PATCH" ? edit._id : comment._id)}`;
      const response = await fetch(target, { method, cache: "no-store", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
      status = response.status;
      const data = await response.json();
      if (!response.ok) {
        const conflict = status === 409 || ["COMMENT_CONFLICT", "COMMENT_NOT_FOUND", "COMMENT_ID_REUSED", "COMMENT_LIMIT_REACHED"].includes(data.error);
        if (active.current) setError({ text: conflict ? "تغيّر التعليق أو حُذف لدى مسؤول آخر. حدّث التعليقات وراجعها قبل المحاولة مجددًا." : "تعذر حفظ التعليق. حاول مرة أخرى.", refresh: conflict });
        if (method === "POST" && status < 500 && active.current) setAddAttempt(null);
        return;
      }
      const incoming = parseComments(data);
      if (active.current) {
        setConfirmed(previous => newest(previous, incoming));
        if (method === "POST") { setAddAttempt(null); setDraft(""); }
        if (method === "PATCH") setEdit(null);
        if (method === "DELETE") { setDeleting(null); if (edit?._id === comment._id) setEdit(null); }
        setNotice(method === "POST" ? "تمت إضافة التعليق" : method === "PATCH" ? "تم حفظ التعليق" : "تم حذف التعليق");
      }
    } catch {
      if (active.current) {
        setError({ text: method === "POST" ? "تعذر تأكيد إضافة التعليق. أعد المحاولة للتحقق من حفظه." : "تعذر تأكيد حفظ التغيير. حاول مرة أخرى." });
        if (method === "POST" && status >= 400 && status < 500) setAddAttempt(null);
      }
    } finally {
      busy.current = false; if (active.current) setPending(false);
    }
  }

  async function refresh() {
    if (busy.current) return;
    busy.current = true; setPending(true);
    try {
      const response = await fetch(base, { cache: "no-store" });
      if (!response.ok) throw new Error("Unavailable");
      const data = parseComments(await response.json());
      if (active.current) {
        // Only this explicit refresh adopts a conflicting revision. The draft stays intact.
        const accepted = newest(confirmed, data);
        setConfirmed(accepted);
        setEdit(current => current ? { ...current, revision: accepted.comments.find(item => item._id === current._id)?.revision || null } : null);
        setDeleting(current => current ? accepted.comments.find(item => item._id === current._id) || null : null);
        setError(null); setNotice("تم تحديث التعليقات. راجع أحدث نص قبل حفظ تعديلاتك.");
      }
    } catch {
      if (active.current) setError({ text: "تعذر تحديث التعليقات. حاول مرة أخرى.", refresh: true });
    } finally {
      busy.current = false; if (active.current) setPending(false);
    }
  }

  return <section aria-label="تعليقات الإدارة" aria-busy={pending} className="mt-6 min-w-0 border-t border-border pt-5">
    <div className="mb-3 flex flex-wrap items-center justify-between gap-3"><h3 className="text-sm font-medium">تعليقات الإدارة</h3><span className="flex items-center gap-1 text-xs text-muted-foreground"><LockKeyhole aria-hidden="true" className="h-3.5 w-3.5" />خاصة بالإدارة</span></div>
    {!confirmed && !error && <div aria-label="جارٍ تحميل التعليقات"><NeonLoader width={160} height={64} /></div>}
    <div className="space-y-3">{confirmed?.comments.map((comment, index) => <article key={comment._id} className="min-w-0 rounded-xl bg-muted/40 p-3 sm:p-4">
      <div className="flex flex-wrap items-start gap-2 sm:flex-nowrap">
        <p className="min-w-0 basis-full whitespace-pre-wrap text-sm leading-7 [overflow-wrap:anywhere] sm:flex-1 sm:basis-auto">{comment.text}</p>
        <div className="ms-auto flex shrink-0">
          <IconButton label={`تعديل التعليق ${index + 1}`} disabled={blocked || Boolean(addAttempt) || Boolean(edit)} onClick={() => { setEdit({ ...comment }); setDeleting(null); setError(null); setNotice(""); }}><Pencil aria-hidden="true" className="h-4 w-4" /></IconButton>
          <IconButton label={`حذف التعليق ${index + 1}`} disabled={blocked || Boolean(addAttempt)} onClick={() => { setDeleting(comment); setError(null); setNotice(""); }}><Trash2 aria-hidden="true" className="h-4 w-4 text-destructive" /></IconButton>
        </div>
      </div>
      {comment.createdAt && Number.isFinite(new Date(comment.createdAt).getTime()) && <p className="mt-1 text-xs text-muted-foreground"><time dateTime={comment.createdAt}>{new Date(comment.createdAt).toLocaleDateString("ar", { timeZone: "Asia/Jerusalem" })}</time>{comment.updatedAt !== comment.createdAt && " · تم التعديل"}</p>}
      {deleting?._id === comment._id && <div className="mt-2 flex flex-wrap items-center gap-2 border-t border-border pt-2"><span className="text-xs">حذف هذا التعليق؟</span><IconButton label="تأكيد حذف التعليق" disabled={blocked || Boolean(addAttempt)} onClick={() => mutate("DELETE", deleting)}><Check aria-hidden="true" className="h-4 w-4 text-destructive" /></IconButton><IconButton label="إلغاء حذف التعليق" disabled={pending} onClick={() => setDeleting(null)}><X aria-hidden="true" className="h-4 w-4" /></IconButton></div>}
    </article>)}</div>
    {edit && <div className="mt-4 min-w-0">
      <label htmlFor={`${id}-edit`} className="mb-2 block text-sm">تعديل التعليق</label>
      <textarea ref={editField} id={`${id}-edit`} value={edit.text} onChange={event => setEdit(current => ({ ...current, text: event.target.value }))} disabled={pending} rows={3} maxLength={10000} className={inputClass} />
      {!edit.revision && <p className="mt-2 text-xs text-destructive">حُذف هذا التعليق. مسودتك ما زالت ظاهرة لنسخها.</p>}
      <div className="mt-2 flex gap-2"><button type="button" className={buttonClass} disabled={blocked || !edit.text.trim() || !edit.revision} onClick={() => mutate("PATCH")}><Check aria-hidden="true" className="h-4 w-4" />حفظ التعليق</button><IconButton label="إلغاء تعديل التعليق" disabled={pending} onClick={() => setEdit(null)}><X aria-hidden="true" className="h-4 w-4" /></IconButton></div>
    </div>}
    <div className="mt-4 min-w-0">
      <label htmlFor={`${id}-draft`} className="mb-2 block text-sm">إضافة تعليق</label>
      <textarea id={`${id}-draft`} value={draft} onChange={event => setDraft(event.target.value)} disabled={pending || Boolean(addAttempt)} rows={2} maxLength={10000} placeholder="اكتب سبب اختيار مدة التذكير أو ملاحظة للمتابعة…" className={inputClass} />
      <button type="button" onClick={() => mutate("POST")} disabled={blocked || !draft.trim() || (confirmed?.comments.length >= 100 && !addAttempt)} className={`${buttonClass} mt-2`}><Plus aria-hidden="true" className="h-4 w-4" />إضافة تعليق</button>
      {confirmed?.comments.length >= 100 && <p className="mt-2 text-xs text-muted-foreground">الحد الأقصى 100 تعليق لهذا الرقم.</p>}
    </div>
    {error && <div className="mt-3"><p role="alert" className="text-sm leading-7 text-destructive">{error.text}</p>{error.refresh && <button type="button" disabled={pending} onClick={refresh} className={`${buttonClass} mt-2`}>تحديث التعليقات</button>}</div>}
    {notice && <p aria-live="polite" className="mt-3 text-xs leading-6 text-primary">{notice}</p>}
    {pending && <div aria-hidden="true"><NeonLoader width={160} height={64} /></div>}
  </section>;
}
