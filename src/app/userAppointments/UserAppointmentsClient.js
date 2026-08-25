"use client";

import { useEffect, useRef, useState } from "react";
import axios from "axios";
import { useRouter } from "next/navigation";

const PUBLIC_APPOINTMENT_ID = /^[0-9a-f]{24}$/;

function getPublicAppointmentId(appointment) {
  if (typeof appointment?._id !== "string") return null;
  const appointmentId = String(appointment._id);
  return PUBLIC_APPOINTMENT_ID.test(appointmentId) ? appointmentId : null;
}

export default function UserAppointmentsClient() {
  const router = useRouter();

  const [appointments, setAppointments] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [loggingOut, setLoggingOut] = useState(false);

  const [confirmCancelKey, setConfirmCancelKey] = useState(null);
  const [cancelingKey, setCancelingKey] = useState(null);
  const cancellationInFlightRef = useRef(false);
  const fetchAppointmentsRef = useRef(null);

  /* ---------------- Fetch appointments ---------------- */
  useEffect(() => {
    let cancelled = false;

    const fetchAppointments = async () => {
      try {
        setLoading(true);
        setError("");

        const res = await axios.get("/api/userAppointments");

        if (cancelled) return;

        setAppointments(
          Array.isArray(res.data?.appointments)
            ? res.data.appointments
            : []
        );
      } catch (requestError) {
        if (cancelled) return;
        if (requestError?.response?.status === 401) {
          router.replace("/login");
          return;
        }
        setError("تعذر تحميل المواعيد. يرجى المحاولة مرة أخرى.");
      } finally {
        if (!cancelled) setLoading(false);
      }
    };

    fetchAppointmentsRef.current = fetchAppointments;

    fetchAppointments();

    return () => {
      cancelled = true;
      if (fetchAppointmentsRef.current === fetchAppointments) {
        fetchAppointmentsRef.current = null;
      }
    };
  }, [router]);

  /* ---------------- Helpers ---------------- */
  async function handleLogout() {
    if (loggingOut) return;

    setLoggingOut(true);
    setError("");
    try {
      await axios.post("/api/customer/logout");
      router.replace("/login");
    } catch {
      setError("تعذر تسجيل الخروج. يرجى المحاولة مرة أخرى.");
    } finally {
      setLoggingOut(false);
    }
  }

  const isFutureAppointment = (a) => {
    if (!a?.date || !a?.time) return false;
    return new Date(`${a.date}T${a.time}:00`).getTime() > Date.now();
  };
  async function handleConfirmCancel(appointment) {
    const appointmentId = getPublicAppointmentId(appointment);
    if (!appointmentId || cancellationInFlightRef.current) return;

    cancellationInFlightRef.current = true;
    setCancelingKey(appointmentId);
    setError("");

    try {
      await axios.delete("/api/appointments/cancelaptByuser", {
        data: { appointmentId: String(appointment._id) },
      });

      setAppointments((prev) =>
        prev.filter((a) => String(a._id) !== appointmentId),
      );
    } catch (requestError) {
      if (requestError?.response?.status === 401) {
        router.replace("/login");
        return;
      }
      if (requestError?.response?.status === 404) {
        setConfirmCancelKey(null);
        const fetchAppointments = fetchAppointmentsRef.current;
        if (fetchAppointments) {
          await fetchAppointments({ showLoading: false });
        }
        return;
      }
      setError("تعذر إلغاء الموعد. يرجى المحاولة مرة أخرى.");
    } finally {
      cancellationInFlightRef.current = false;
      setCancelingKey(null);
      setConfirmCancelKey(null);
    }
  }

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
            </div>

            <button
              onClick={handleLogout}
              disabled={loggingOut}
              className="
                rounded-full px-5 py-3 text-sm font-semibold
                border border-foreground/10 bg-background/50 backdrop-blur
                hover:border-primary/30 hover:shadow-elevated transition
                disabled:cursor-not-allowed disabled:opacity-50
              "
            >
              {loggingOut ? "جارٍ تسجيل الخروج..." : "تسجيل الخروج"}
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
            <p className="text-subtle">لا توجد مواعيد.</p>
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
                  {appointments.map((a, index) => {
                    const future = isFutureAppointment(a);
                    const appointmentId = getPublicAppointmentId(a);
                    const key = appointmentId ?? `invalid-appointment-${index}`;
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
                          {future && appointmentId ? (
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
                          ) : !future ? (
                            <span className="text-xs text-foreground/70">
                              {a.attended
                                ? "تم الحضور"
                                : "لم يتم الحضور"}
                            </span>
                          ) : (
                            <button
                              disabled
                              className="
                                rounded-full px-4 py-2 text-xs font-semibold
                                bg-destructive/15 border border-destructive/20
                                opacity-50
                              "
                            >
                              إلغاء
                            </button>
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
