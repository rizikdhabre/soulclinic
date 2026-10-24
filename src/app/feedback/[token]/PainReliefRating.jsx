"use client";

import { useId } from "react";

export default function PainReliefRating({ value, onChange, disabled }) {
  const id = useId();
  return (
    <fieldset disabled={disabled} aria-describedby={`${id}-help ${id}-scale`} className="mb-6 min-w-0 border-b border-border pb-5">
      <legend className="flex w-full flex-wrap items-center gap-2 text-base font-semibold leading-[1.9]">
        <span>قديش خفّ الوجع عندك بعد الجلسة؟</span>
        <span className="rounded-full bg-primary/10 px-2.5 py-0.5 text-[11px] font-medium">مطلوب</span>
      </legend>
      <p id={`${id}-help`} className="mb-3 mt-2 text-[13px] leading-6 text-muted-foreground">اختَر درجة من 1 إلى 10، كل ما زاد الرقم كان التحسّن أكبر.</p>
      <div className="-mx-4 overflow-x-auto px-0.5 py-1 sm:mx-0">
        <div dir="ltr" className="grid grid-cols-[repeat(10,minmax(24px,1fr))] gap-0.5 sm:gap-[7px]">
          {Array.from({ length: 10 }, (_, index) => index + 1).map(score => (
            <label key={score} className="relative min-w-0 cursor-pointer">
              <input
                type="radio" name="painRelief" value={score} required checked={value === score}
                onChange={() => onChange(score)}
                aria-label={`${score} من 10${score === 1 ? " — ما خفّ الوجع" : score === 10 ? " — خفّ الوجع كثير" : ""}`}
                className="peer absolute inset-0 m-0 h-full w-full cursor-pointer opacity-0 disabled:cursor-wait"
              />
              <span aria-hidden="true" className="flex min-h-12 items-center justify-center rounded-lg border border-border bg-background/50 text-sm font-semibold tabular-nums transition-colors peer-checked:border-primary peer-checked:bg-primary peer-checked:text-primary-foreground peer-checked:ring-2 peer-checked:ring-primary/20 peer-hover:border-primary peer-focus-visible:outline peer-focus-visible:outline-2 peer-focus-visible:outline-offset-2 peer-focus-visible:outline-foreground peer-disabled:opacity-60 motion-reduce:transition-none sm:rounded-xl sm:text-lg">{score}</span>
            </label>
          ))}
        </div>
      </div>
      <div id={`${id}-scale`} dir="ltr" className="mt-2 flex justify-between gap-2 text-[11px] leading-5 text-muted-foreground sm:text-xs">
        <span dir="rtl"><bdi>1</bdi> · ما خفّ الوجع</span>
        <span dir="rtl"><bdi>10</bdi> · خفّ الوجع كثير</span>
      </div>
      <p role="status" className={`mt-3 min-h-8 rounded-lg px-3 py-1.5 text-center text-xs leading-5 ${value ? "bg-primary/10 font-medium text-foreground" : "bg-muted/40 text-muted-foreground"}`}>
        {value ? <>تقييمك: <bdi dir="ltr">{value} / 10</bdi></> : "اختَر رقمًا للمتابعة"}
      </p>
    </fieldset>
  );
}
