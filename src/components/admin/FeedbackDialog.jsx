"use client";

import { useEffect, useId, useRef } from "react";
import { createPortal } from "react-dom";
import { X } from "lucide-react";

export default function FeedbackDialog({ appointment, onClose }) {
  const dialogRef = useRef(null);
  const closeRef = useRef(null);
  const titleId = useId();

  useEffect(() => {
    const previousFocus = document.activeElement;
    const dialog = dialogRef.current;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    dialog.showModal();
    closeRef.current?.focus();
    return () => {
      dialog.close();
      document.body.style.overflow = previousOverflow;
      if (previousFocus?.isConnected) previousFocus.focus();
    };
  }, []);

  const trapFocus = (event) => {
    if (event.key !== "Tab") return;
    const controls = [...dialogRef.current.querySelectorAll('button, [href], [tabindex="0"]')];
    const first = controls[0];
    const last = controls[controls.length - 1];
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last?.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first?.focus();
    }
  };

  return createPortal(
    <dialog
      ref={dialogRef}
      dir="rtl"
      aria-labelledby={titleId}
      aria-modal="true"
      onCancel={(event) => { event.preventDefault(); onClose(); }}
      onKeyDown={trapFocus}
      onClick={(event) => {
        if (event.target !== event.currentTarget) return;
        const bounds = event.currentTarget.getBoundingClientRect();
        if (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom) onClose();
      }}
      className="m-auto w-[calc(100%-2rem)] max-w-2xl overflow-hidden rounded-2xl border border-border bg-card p-0 text-foreground shadow-xl backdrop:bg-black/50"
    >
      <div className="flex max-h-[85dvh] min-h-0 flex-col">
        <div className="flex shrink-0 items-start justify-between gap-4 border-b border-border p-5">
          <div className="min-w-0">
            <h2 id={titleId} className="text-lg font-semibold">ملاحظة الزبون</h2>
            <p className="mt-1 break-words text-sm text-muted-foreground">{appointment.title}</p>
            <p className="mt-1 text-sm text-muted-foreground"><bdi>{appointment.date} · {appointment.time}</bdi></p>
          </div>
          <button ref={closeRef} type="button" onClick={onClose} aria-label="إغلاق" className="shrink-0 rounded-lg p-2 hover:bg-muted focus-visible:outline focus-visible:outline-2 focus-visible:outline-primary">
            <X className="h-5 w-5" aria-hidden="true" />
          </button>
        </div>
        <div tabIndex={0} aria-label="نص الملاحظة" className="min-h-0 overflow-y-auto overscroll-contain p-5 focus-visible:outline focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-primary">
          <p data-feedback-text className="whitespace-pre-wrap text-sm leading-8 [overflow-wrap:anywhere]">{appointment.feedback.text}</p>
        </div>
      </div>
    </dialog>,
    document.body,
  );
}
