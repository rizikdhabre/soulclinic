"use client";

import { useEffect, useState } from "react";

const HIJRI_DAYS = [17, 19, 21];

export default function HijriCuppingTable() {
  const [dates, setDates] = useState([]);
  const [gregorianDate, setGregorianDate] = useState("");
  const [hijriDate, setHijriDate] = useState("");

  useEffect(() => {
    const now = new Date();
    const yesterday = new Date(now);
    yesterday.setDate(now.getDate() - 1);
    const gregorian = now.toLocaleDateString("en-GB");
    const hijri = new Intl.DateTimeFormat("ar-SA-u-ca-islamic-nu-latn", {
      day: "numeric",
      month: "long",
      year: "numeric",
      timeZone: "Asia/Jerusalem",
    }).format(yesterday);

    setGregorianDate(`${gregorian} ميلادي`);
    setHijriDate(`${hijri} `);

    const hijriDayFormatter = new Intl.DateTimeFormat("en-u-ca-islamic-nu-latn", {
      day: "numeric",
      timeZone: "Asia/Jerusalem",
    });

    const hijriLabelFormatter = new Intl.DateTimeFormat("ar-SA-u-ca-islamic-nu-latn", {
      day: "numeric",
      month: "long",
      year: "numeric",
      timeZone: "Asia/Jerusalem",
    });

    const gregorianFormatter = new Intl.DateTimeFormat("en-GB", {
      day: "2-digit",
      month: "2-digit",
      year: "numeric",
      timeZone: "Asia/Jerusalem",
    });

    const startDate = new Date(yesterday);
    startDate.setHours(12, 0, 0, 0);

    const results = [];

    for (let offset = 1; offset <= 120 && results.length < 3; offset += 1) {
      const currentDate = new Date(startDate);
      currentDate.setDate(startDate.getDate() + offset);

      const hijriDay = Number(hijriDayFormatter.format(currentDate));

      if (!HIJRI_DAYS.includes(hijriDay)) {
        continue;
      }

      const displayDate = new Date(currentDate);
      displayDate.setDate(currentDate.getDate() + 1);

      results.push({
        hijri: hijriLabelFormatter.format(currentDate),
        gregorian: gregorianFormatter.format(displayDate),
      });
    }

    setDates(results);
  }, []);

  return (
    <div className="mt-10 w-full max-w-2xl mx-auto px-4" dir="rtl">
      <h2 className="text-center text-xl md:text-2xl font-semibold mb-4 text-foreground">
        أفضل أيام الحجامة هي الأيام الفردية في الشهر الهجري: 17، 19، 21
      </h2>

      <div className="overflow-hidden rounded-2xl border border-muted bg-background/70 backdrop-blur-sm shadow-sm">
        <table className="w-full text-center">
          <thead className="bg-muted/50">
            <tr>
              <th className="py-3 px-4">التاريخ الهجري</th>
              <th className="py-3 px-4">التاريخ الميلادي</th>
            </tr>
          </thead>

          <tbody>
            <tr className="border-b bg-primary/5">
              <td colSpan={2} className="px-4 py-5">
                <div className="flex flex-col items-center gap-1 text-center">
                  <p className="text-xs md:text-sm tracking-widest text-muted-foreground">
                    اليوم
                  </p>
                  <p className="text-base md:text-lg font-semibold text-foreground">
                    {gregorianDate}
                  </p>
                  <p className="text-base md:text-lg font-semibold text-primary">
                    {hijriDate}
                  </p>
                </div>
              </td>
            </tr>
            {dates.map((d, i) => (
              <tr key={i} className="border-t">
                <td className="py-3 px-4 font-bold text-primary">
                  {d.hijri}
                </td>
                <td className="py-3 px-4">{d.gregorian}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}