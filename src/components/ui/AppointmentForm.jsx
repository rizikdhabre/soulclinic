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

  const canSubmit =
    selectedDate &&
    selectedTime &&
    data.firstName &&
    data.lastName &&
    data.phone;

  // STEP 1 — Send OTP
  const handleSendOTP = async (e) => {
    e.preventDefault();
    if (!canSubmit) return;

    const normalizedPhone = normalizeIsraeliPhone(data.phone);
    if (!normalizedPhone) {
      setMessageType("error");
      setMessage("Please enter a valid Israeli phone number");
      return;
    }

    setLoading(true);

    try {
      const confirm = await sendOTP(normalizedPhone);
      setConfirmation(confirm);
      setData((d) => ({ ...d, phone: normalizedPhone }));
      setStep("otp");
    } catch (err) {
      setMessageType("error");
      setMessage("Too many attempts. Please wait a bit and try again.");
    } finally {
      setLoading(false);
    }
  };

  const handleVerifyOTP = async () => {
    if (!otp || !confirmation) return;

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
    }
  };

  if (step === "success") {
    return (
      <div className="text-center py-12">
        <Check className="mx-auto mb-4 text-green-500 w-8 h-8" />
        <h3 className="text-lg font-semibold">Appointment Confirmed</h3>
        <p className="text-muted-foreground mt-2">
          {format(selectedDate, "PPP")} at {selectedTime}
        </p>
      </div>
    );
  }

  return (
    <>
      <div id="recaptcha-container" />

      {/* FORM STEP */}
      {step === "form" && (
        <form
          onSubmit={handleSendOTP}
          className="space-y-4 rounded-2xl bg-card p-6 border border-border"
        >
          <input
            placeholder="الاسم الأول"
            value={data.firstName}
            onChange={(e) => setData({ ...data, firstName: e.target.value })}
            className="
              w-full rounded-xl border px-4 py-3
              bg-background
              text-foreground
              placeholder:text-muted-foreground
              border-border
              focus:outline-none
              focus:ring-2
              focus:ring-primary/40
            "
          />
          <input
            placeholder="اسم العائلة"
            value={data.lastName}
            onChange={(e) => setData({ ...data, lastName: e.target.value })}
            className="
              w-full rounded-xl border px-4 py-3
              bg-background
              text-foreground
              placeholder:text-muted-foreground
              border-border
              focus:outline-none
              focus:ring-2
              focus:ring-primary/40
  "
          />

          <input
            placeholder="رقم الهاتف"
            value={data.phone}
            onChange={(e) => setData({ ...data, phone: e.target.value })}
            className="
    w-full rounded-xl border px-4 py-3
    bg-background
    text-foreground
    placeholder:text-muted-foreground
    border-border
    focus:outline-none
    focus:ring-2
    focus:ring-primary/40
  "
          />

          <textarea
            placeholder="إضافة ملاحظة (اختياري)"
            value={data.note}
            onChange={(e) => setData({ ...data, note: e.target.value })}
            rows={4}
            className="
    w-full rounded-xl border px-4 py-3
    bg-background
    text-foreground
    placeholder:text-muted-foreground
    border-border
    focus:outline-none
    focus:ring-2
    focus:ring-primary/40
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
        <div className="space-y-4 rounded-2xl bg-card p-6 border border-border">
          <input
            placeholder="Enter verification code"
            value={otp}
            onChange={(e) => setOtp(e.target.value)}
            className="
    w-full rounded-xl border px-4 py-3
    bg-background
    text-foreground
    placeholder:text-muted-foreground
    border-border
    focus:outline-none
    focus:ring-2
    focus:ring-primary/40
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
    </>
  );
}
