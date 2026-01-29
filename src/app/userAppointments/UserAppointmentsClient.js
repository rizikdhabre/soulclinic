"use client";

import { useEffect, useMemo, useState } from "react";
import axios from "axios";
import { useSearchParams, useRouter } from "next/navigation";
import { normalizeIsraeliPhone } from "@/lib/phone";

export default function UserAppointmentsClient() {
  const router = useRouter();
  const searchParams = useSearchParams();

  const rawPhone = searchParams.get("phone") || "";
  const phone = useMemo(() => normalizeIsraeliPhone(rawPhone), [rawPhone]);

  const [appointments, setAppointments] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  const [confirmCancelKey, setConfirmCancelKey] = useState(null);
  const [cancelingKey, setCancelingKey] = useState(null);

  /* ---------------- Fetch appointments ---------------- */
  useEffect(() => {
    if (!phone) {
      router.replace("/login");
      return;
    }

    let cancelled = false;

    const fetchAppointments = async () => {
      try {
        setLoading(true);
        setError("");

        const res = await axios.get("/api/userAppointments/", {
          params: { phone },
        });

        if (cancelled) return;

        setAppointments(
          Array.isArray(res.data?.appointments)
            ? res.data.appointments
            : []
        );
      } catch (e) {
        if (cancelled) return;
        setError(
          e?.response?.data?.message ||
            e?.message ||
            "فشل تحميل المواعيد."
        );
      } finally {
        if (!cancelled) setLoading(false);
      }
    };

    fetchAppointments();

    return () => {
      cancelled = true;
    };
  }, [phone, router]);

  /* ---------------- Helpers ---------------- */
  const isFutureAppointment = (a) => {
    if (!a?.date || !a?.time) return false;
    return new Date(`${a.date}T${a.time}:00`).getTime() > Date.now();
  };
  const handleConfirmCancel = async (appointment) => {
    const { date, time } = appointment;
    const key = `${date}-${time}`;

    setCancelingKey(key);

    try {
      await axios.delete("/api/appointments/cancelaptByuser", {
        data: { phone, date, time },
      });

      setAppointments((prev) =>
        prev.filter(
          (a) => !(a.date === date && a.time === time)
        )
      );
    } catch (e) {
      setError(
        e?.response?.data?.error ||
          e?.message ||
          "فشل إلغاء الموعد."
      );
    } finally {
      setCancelingKey(null);
      setConfirmCancelKey(null);
    }
  };

  /* ---------------- Render ---------------- */
  return (
    <div className="min-h-screen wellness-gradient px-4 py-10">
      <div className="container mx-auto max-w-4xl">
        <div className="glass-card p-6" dir="rtl">
          {/* Header */}
          <div className="flex items-end justify-between mb-6">
            <div>
              <h2 className="heading-section text-foreground mb-1">
                مواعيدي
              </h2>
              <p className="text-subtle">{phone}</p>
            </div>

            <button
              onClick={() => router.push("/login")}
              className="
                rounded-full px-5 py-3 text-sm font-semibold
                border border-foreground/10 bg-background/50 backdrop-blur
                hover:border-primary/30 hover:shadow-elevated transition
              "
            >
              رجوع
            </button>
          </div>

          {/* States */}
          {loading && <p className="text-subtle">جاري التحميل…</p>}

          {!loading && error && (
            <div className="mb-4 rounded-2xl border border-destructive/20 bg-destructive/10 p-4">
              {error}
            </div>
          )}

          {!loading && !error && appointments.length === 0 && (
            <p className="text-subtle">لا توجد مواعيد لهذا الرقم.</p>
          )}

          {/* Table */}
          {!loading && !error && appointments.length > 0 && (
            <div className="overflow-x-auto rounded-2xl border border-foreground/10">
              <table className="min-w-full text-sm">
                <thead className="bg-background/40">
                  <tr className="text-right">
                    <th className="px-4 py-3">التاريخ</th>
                    <th className="px-4 py-3">الوقت</th>
                    <th className="px-4 py-3">السعر</th>
                    <th className="px-4 py-3">الإجراء</th>
                  </tr>
                </thead>

                <tbody className="divide-y divide-foreground/10">
                  {appointments.map((a) => {
                    const future = isFutureAppointment(a);
                    const key = `${a.date}-${a.time}`;
                    const isConfirming = confirmCancelKey === key;
                    const isCanceling = cancelingKey === key;

                    return (
                      <tr key={key}>
                        <td className="px-4 py-3">{a.date}</td>
                        <td className="px-4 py-3">{a.time}</td>
                        <td className="px-4 py-3">
                          ₪{a.price ?? "-"}
                        </td>

                        <td className="px-4 py-3">
                          {future ? (
                            !isConfirming ? (
                              <button
                                onClick={() =>
                                  setConfirmCancelKey(key)
                                }
                                className="
                                  rounded-full px-4 py-2 text-xs font-semibold
                                  bg-destructive/15 border border-destructive/20
                                  hover:bg-destructive/25 transition
                                "
                              >
                                إلغاء
                              </button>
                            ) : (
                              <div className="flex gap-2">
                                <button
                                  onClick={() =>
                                    handleConfirmCancel(a)
                                  }
                                  disabled={isCanceling}
                                  className="
                                    rounded-full px-4 py-2 text-xs font-semibold
                                    bg-destructive text-white
                                    hover:bg-destructive/90 transition
                                    disabled:opacity-50
                                  "
                                >
                                  {isCanceling
                                    ? "جارٍ الإلغاء..."
                                    : "تأكيد الإلغاء"}
                                </button>

                                <button
                                  onClick={() =>
                                    setConfirmCancelKey(null)
                                  }
                                  className="
                                    rounded-full px-4 py-2 text-xs font-semibold
                                    border border-foreground/20
                                    hover:bg-background/60 transition
                                  "
                                >
                                  تراجع
                                </button>
                              </div>
                            )
                          ) : (
                            <span className="text-xs text-foreground/70">
                              {a.attended
                                ? "تم الحضور"
                                : "لم يتم الحضور"}
                            </span>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>

        <p className="mt-4 text-xs text-center text-foreground/60" dir="rtl">
          * يمكن إلغاء المواعيد المستقبلية فقط
        </p>
      </div>
    </div>
  );
}
