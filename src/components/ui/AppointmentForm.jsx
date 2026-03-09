"use client";

import { useState } from "react";
import { Check } from "lucide-react";
import { format } from "date-fns";
import { sendOTP } from "@/lib/phoneAuth";
import { normalizeIsraeliPhone } from "@/lib/phone";

export function AppointmentForm({
  selectedDate,
  selectedTime,
  onSubmit,
  bookingError,
}) {
  const [data, setData] = useState({
    firstName: "",
    lastName: "",
    phone: "",
    note: "",
  });

  const [step, setStep] = useState("form");
  const [confirmation, setConfirmation] = useState(null);
  const [otp, setOtp] = useState("");
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState("");
  const [messageType, setMessageType] = useState("info");
  const [loadingStage, setLoadingStage] = useState(null); // "send" | "verify" | null

  const canSubmit =
    selectedDate &&
    selectedTime &&
    data.firstName &&
    data.lastName &&
    data.phone;

  const handleSendOTP = async (e) => {
    e.preventDefault();
    if (!canSubmit) return;

    const normalizedPhone = normalizeIsraeliPhone(data.phone);
    if (!normalizedPhone) {
      setMessageType("error");
      setMessage("Please enter a valid Israeli phone number");
      return;
    }

    setLoadingStage("send");

    setLoading(true);

    try {
      if (process.env.NODE_ENV === "development") {
        setConfirmation({
          confirm: async (code) => {
            if (code === "123456") return true;
            throw new Error("Invalid code");
          },
        });

        setData((d) => ({ ...d, phone: normalizedPhone }));
        setStep("otp");
        setLoading(false);
        setLoadingStage(null);
        return;
      }

      const confirm = await sendOTP(normalizedPhone);
      setConfirmation(confirm);
      setData((d) => ({ ...d, phone: normalizedPhone }));
      setStep("otp");
    } catch (err) {
      setMessageType("error");
      setMessage("Too many attempts. Please wait a bit and try again.");
    } finally {
      setLoading(false);
      setLoadingStage(null);
    }
  };

  const handleVerifyOTP = async () => {
    if (!otp || !confirmation) return;

    setLoadingStage("verify");
    setLoading(true);

    try {
      await confirmation.confirm(otp);
      await onSubmit(data);
      setStep("success");
    } catch {
      setMessageType("error");
      setMessage("Invalid verification code. Please try again.");
    } finally {
      setLoading(false);
      setLoadingStage(null);
    }
  };

  return (
    <>
      <div id="recaptcha-container" />

      {loading && loadingStage === "send" && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
          role="dialog"
          aria-modal="true"
        >
          <div
            dir="rtl"
            className="w-full max-w-md rounded-2xl bg-card border border-border p-6 shadow-xl"
          >
            <div className="text-base font-semibold">
              انتظر، نحن نرسل لك رمزًا
            </div>
            <div className="mt-2 text-sm text-muted-foreground">
              لا تغادر الصفحة حتى تقوم بإدخال الرمز وإتمام التأكيد.
            </div>

            <div className="mt-4 h-1.5 w-full overflow-hidden rounded-full bg-muted">
              <div className="h-full w-1/2 animate-pulse bg-primary" />
            </div>
          </div>
        </div>
      )}

      <div className="w-full md:w-auto min-h-[70vh] md:min-h-0 flex items-center justify-center md:block px-4 md:px-0">
        <div className="w-full max-w-md md:max-w-none">
          {/* FORM STEP */}
          {step === "form" && (
            <form
              onSubmit={handleSendOTP}
              className="
            space-y-4 rounded-2xl bg-card p-6 border border-border
            min-h-[350px] md:min-h-0
            flex flex-col justify-center md:block
          "
            >
              <input
                placeholder="الاسم الأول"
                value={data.firstName}
                onChange={(e) =>
                  setData({ ...data, firstName: e.target.value })
                }
                className="
              w-full rounded-xl border px-4 py-3
              bg-background text-foreground
              placeholder:text-muted-foreground
              border-border
              focus:outline-none focus:ring-2 focus:ring-primary/40
            "
              />

              <input
                placeholder="اسم العائلة"
                value={data.lastName}
                onChange={(e) => setData({ ...data, lastName: e.target.value })}
                className="
              w-full rounded-xl border px-4 py-3
              bg-background text-foreground
              placeholder:text-muted-foreground
              border-border
              focus:outline-none focus:ring-2 focus:ring-primary/40
            "
              />

              <input
                placeholder="رقم الهاتف"
                value={data.phone}
                onChange={(e) => setData({ ...data, phone: e.target.value })}
                className="
              w-full rounded-xl border px-4 py-3
              bg-background text-foreground
              placeholder:text-muted-foreground
              border-border
              focus:outline-none focus:ring-2 focus:ring-primary/40
            "
              />

              <textarea
                placeholder="إضافة ملاحظة (اختياري)"
                value={data.note}
                onChange={(e) => setData({ ...data, note: e.target.value })}
                rows={4}
                className="
              w-full rounded-xl border px-4 py-3
              bg-background text-foreground
              placeholder:text-muted-foreground
              border-border
              focus:outline-none focus:ring-2 focus:ring-primary/40
              resize-none
            "
              />

              {message && (
                <div
                  className={`
                rounded-xl px-4 py-3 text-sm
                ${
                  messageType === "error"
                    ? "bg-red-500/10 text-red-600"
                    : messageType === "success"
                      ? "bg-green-500/10 text-green-600"
                      : "bg-primary/10 text-primary"
                }
              `}
                >
                  {message}
                </div>
              )}

              {bookingError && (
                <div className="rounded-xl bg-red-500/10 text-red-600 px-4 py-3 text-sm">
                  {bookingError}
                </div>
              )}

              <button
                type="submit"
                disabled={!canSubmit || loading}
                className="w-full rounded-xl py-3 bg-primary text-white disabled:opacity-50"
              >
                {loading ? "جارٍ إرسال الرمز..." : "تأكيد الموعد"}
              </button>
            </form>
          )}

          {/* OTP STEP */}
          {step === "otp" && (
            <div
              className="
            space-y-4 rounded-2xl bg-card p-6 border border-border
            min-h-[350px] md:min-h-0
            flex flex-col justify-center md:block
          "
            >
              <input
                placeholder="Enter verification code"
                value={otp}
                onChange={(e) => setOtp(e.target.value)}
                className="
              w-full rounded-xl border px-4 py-3
              bg-background text-foreground
              placeholder:text-muted-foreground
              border-border
              focus:outline-none focus:ring-2 focus:ring-primary/40
            "
              />

              {message && (
                <div
                  className={`
                rounded-xl px-4 py-3 text-sm
                ${
                  messageType === "error"
                    ? "bg-red-500/10 text-red-600"
                    : messageType === "success"
                      ? "bg-green-500/10 text-green-600"
                      : "bg-primary/10 text-primary"
                }
              `}
                >
                  {message}
                </div>
              )}

              {bookingError && (
                <div className="rounded-xl bg-red-500/10 text-red-600 px-4 py-3 text-sm">
                  {bookingError}
                </div>
              )}

              <button
                onClick={handleVerifyOTP}
                disabled={loading}
                className="w-full rounded-xl py-3 bg-primary text-white disabled:opacity-50"
              >
                {loading ? "جارٍ التحقق..." : "التحقق وحفظ الموعد"}
              </button>
            </div>
          )}

          {/* SUCCESS STEP */}
          {step === "success" && (
            <div
              className="
            space-y-4 rounded-2xl bg-card p-6 border border-border
            min-h-[350px] md:min-h-0
            flex flex-col justify-center items-center
          "
            >
              <Check className="mb-4 text-green-500 w-8 h-8" />
              <h3 className="text-lg font-semibold">تم الحجز بنجاح</h3>
              <p className="text-muted-foreground mt-2 text-center">
                {format(selectedDate, "PPP")} at {selectedTime}
              </p>
            </div>
          )}
        </div>
      </div>
    </>
  );
}
