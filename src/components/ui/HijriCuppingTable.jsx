"use client";

import { useEffect, useState } from "react";
import { MoonStar } from "lucide-react";
import { formatCuppingDate, getClinicDateKey, getUpcomingCuppingDates } from "@/lib/hijriCuppingDates";
import styles from "./HijriCupping.module.css";

export default function HijriCuppingTable() {
  const [todayKey, setTodayKey] = useState(null);

  useEffect(() => {
    const updateDate = () => setTodayKey(getClinicDateKey());
    updateDate();
    const timer = setInterval(updateDate, 60_000);
    document.addEventListener("visibilitychange", updateDate);
    return () => {
      clearInterval(timer);
      document.removeEventListener("visibilitychange", updateDate);
    };
  }, []);

  const today = todayKey ? formatCuppingDate(todayKey) : null;
  const dates = todayKey ? getUpcomingCuppingDates(todayKey) : [];
  // Preserve the existing display-only one-day adjustment for today's Hijri label.
  // Upcoming dates and booking markers both use the unshifted Umm al-Qura calendar.
  const displayDate = todayKey ? new Date(`${todayKey}T12:00:00Z`) : null;
  if (displayDate) displayDate.setUTCDate(displayDate.getUTCDate() - 1);
  const todayHijri = displayDate ? formatCuppingDate(displayDate.toISOString().slice(0, 10)) : null;

  return (
    <section className={`${styles.scope} ${styles.section}`} dir="rtl" aria-labelledby="hijri-cupping-title">
      <h2 id="hijri-cupping-title" className={styles.heading}>تواريخ الحجامة السُنية للشهر الهجري</h2>
      <div className={styles.ornament} aria-hidden="true"><span /></div>
      <div className={styles.todayPanel} aria-label="تاريخ اليوم الهجري والميلادي">
        <span className={styles.todayBadge}>اليوم</span>
        <div className={styles.dateGroup}>
          <p className={styles.caption}>التاريخ الهجري</p>
          <p className={styles.currentHijri}>{todayHijri ? `${todayHijri.hijriDay} ${todayHijri.hijriMonth}` : "—"}</p>
          <p className={styles.dateDetail}>{todayHijri ? `${todayHijri.hijriYear} هـ` : "—"}</p>
        </div>
        <div className={styles.dateDivider} aria-hidden="true"><span className={styles.moon}><MoonStar size={18} /></span></div>
        <div className={styles.dateGroup}>
          <p className={styles.caption}>التاريخ الميلادي</p>
          <p className={styles.currentGregorian} dir="ltr">{today?.gregorianLabel || "—"}</p>
          <p className={styles.dateDetail}>{today?.weekday || "—"}</p>
        </div>
      </div>
      <h3 className={styles.nextHeading}>مواعيد الحجامة القادمة</h3>
      <div className={styles.cards}>
        {dates.map((date, index) => (
          <article key={date.date} data-hijri-card className={`${styles.dateCard} ${index === 0 ? styles.nearest : ""}`} aria-label={date.hijriLabel}>
            {index === 0 && <span className={styles.nearestBadge}>الموعد الأقرب</span>}
            <p className={styles.dayNumber}>{date.hijriDay}</p>
            <h4 className={styles.hijriMonth}>{date.hijriMonth}</h4>
            <p className={styles.hijriYear}>{date.hijriYear} هـ</p>
            <span className={styles.cardDivider} aria-hidden="true" />
            <time className={styles.gregorian} dateTime={date.date} dir="ltr">{date.gregorianLabel}</time>
            <p className={styles.weekday}>{date.weekday}</p>
          </article>
        ))}
      </div>
    </section>
  );
}
