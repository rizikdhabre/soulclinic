"use client";

import { useEffect, useRef, useState } from "react";
import { Check } from "lucide-react";
import { format } from "date-fns";
import { sendOTP } from "@/lib/phoneAuth";
import { normalizeIsraeliPhone } from "@/lib/phone";

const OTP_RESEND_COOLDOWN_SECONDS = 45;

function getOtpCooldownMessage(seconds) {
  return `Please wait ${seconds} seconds before requesting another verification code.`;
}

function getOtpErrorMessage(error) {
  const code = error?.code || "otp/send-failed";
  const message =
    error?.message || "Unable to send verification code. Please try again.";

  if (code === "auth/too-many-requests") {
    return `${code}: ${message}`;
  }

  return `${code}: ${message}`;
}

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

  const [step, setStep] = useState("phone");
  const [confirmation, setConfirmation] = useState(null);
  const [otp, setOtp] = useState("");
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState("");
  const [messageType, setMessageType] = useState("info");
  const [loadingStage, setLoadingStage] = useState(null); // "lookup" | "send" | "verify" | null
  const [existingUserName, setExistingUserName] = useState("");
  const [otpCooldownSeconds, setOtpCooldownSeconds] = useState(0);
  const otpSendInFlightRef = useRef(false);

  const isOtpCoolingDown = otpCooldownSeconds > 0;
  const hasPhoneForFlow = selectedDate && selectedTime && data.phone;
  const hasDetailsForOtp = data.firstName && data.lastName;
  const canStartFlow = hasPhoneForFlow && !isOtpCoolingDown;
  const canSendOtpForNewUser = hasDetailsForOtp && !isOtpCoolingDown;

  useEffect(() => {
    if (otpCooldownSeconds <= 0) return;

    const timeoutId = window.setTimeout(() => {
      setOtpCooldownSeconds((seconds) => Math.max(seconds - 1, 0));
    }, 1000);

    return () => window.clearTimeout(timeoutId);
  }, [otpCooldownSeconds]);

  const showMessage = (type, text) => {
    setMessageType(type);
    setMessage(text);
  };

  const sendOtpForPhone = async (normalizedPhone) => {
    if (otpSendInFlightRef.current) return;

    if (isOtpCoolingDown) {
      showMessage("error", getOtpCooldownMessage(otpCooldownSeconds));
      return;
    }

    otpSendInFlightRef.current = true;
    setLoadingStage("send");
    setLoading(true);
    setMessage("");

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
      setOtpCooldownSeconds(OTP_RESEND_COOLDOWN_SECONDS);
      setStep("otp");
    } catch (error) {
      console.error("Appointment OTP send failed", error);
      showMessage("error", getOtpErrorMessage(error));
    } finally {
      otpSendInFlightRef.current = false;
      setLoading(false);
      setLoadingStage(null);
    }
  };

  const handleLookupUser = async (e) => {
    e.preventDefault();

    if (loading) return;

    if (isOtpCoolingDown) {
      showMessage("error", getOtpCooldownMessage(otpCooldownSeconds));
      return;
    }

    if (!hasPhoneForFlow) return;

    const normalizedPhone = normalizeIsraeliPhone(data.phone);

    if (!normalizedPhone) {
      showMessage("error", "Please enter a valid Israeli phone number");
      return;
    }

    setLoadingStage("lookup");
    setLoading(true);
    setMessage("");

    try {
      const response = await fetch(
        `/api/appointments/user?phone=${encodeURIComponent(normalizedPhone)}`,
        {
          cache: "no-store",
        },
      );

      const payload = await response.json();

      if (!response.ok) {
        throw new Error(
          payload.message || "Unable to validate this phone number right now.",
        );
      }

      const firstName = payload.firstName || "";
      const lastName = payload.lastName || "";
      const fullName = `${firstName} ${lastName}`.trim();
      const phone = payload.phone || normalizedPhone;

      setData((current) => ({
        ...current,
        phone,
        firstName,
        lastName,
      }));

      if (payload.exists && firstName && lastName) {
        setExistingUserName(fullName);
        await sendOtpForPhone(phone);
        return;
      }

      setExistingUserName(fullName);
      setStep("details");
      showMessage(
        "info",
        payload.exists
          ? "أكمل الاسم لهذا الرقم ثم أرسل رمز التحقق."
          : "هذا رقم جديد. أدخل الاسم الأول واسم العائلة ثم أرسل رمز التحقق.",
      );
    } catch (error) {
      showMessage(
        "error",
        error.message || "Unable to check this number right now.",
      );
    } finally {
      setLoading(false);
      setLoadingStage(null);
    }
  };

  const handleSendOtpForNewUser = async (e) => {
    e.preventDefault();

    if (loading) return;

    if (isOtpCoolingDown) {
      showMessage("error", getOtpCooldownMessage(otpCooldownSeconds));
      return;
    }

    if (!hasDetailsForOtp) return;

    const normalizedPhone = normalizeIsraeliPhone(data.phone);

    if (!normalizedPhone) {
      showMessage("error", "Please enter a valid Israeli phone number");
      setStep("phone");
      return;
    }

    setData((current) => ({ ...current, phone: normalizedPhone }));
    setExistingUserName("");
    await sendOtpForPhone(normalizedPhone);
  };

  const handleResendOTP = async () => {
    if (loading) return;

    const normalizedPhone = normalizeIsraeliPhone(data.phone);

    if (!normalizedPhone) {
      showMessage("error", "Please enter a valid Israeli phone number");
      setStep("phone");
      return;
    }

    setOtp("");
    await sendOtpForPhone(normalizedPhone);
  };

  const handleVerifyOTP = async () => {
    if (!otp.trim() || !confirmation) return;

    setLoadingStage("verify");
    setLoading(true);
    setMessage("");

    try {
      await confirmation.confirm(otp.trim());
      const submitted = await onSubmit(data);

      if (submitted === false) {
        return;
      }

      setStep("success");
    } catch {
      showMessage("error", "Invalid verification code. Please try again.");
    } finally {
      setLoading(false);
      setLoadingStage(null);
    }
  };

  return (
    <>
      <div id="recaptcha-container" />

      {loading && (loadingStage === "lookup" || loadingStage === "send") && (
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
              {loadingStage === "lookup"
                ? "نقوم بالتحقق من رقم الهاتف"
                : "انتظر، نحن نرسل لك رمزًا"}
            </div>
            <div className="mt-2 text-sm text-muted-foreground">
              {loadingStage === "lookup"
                ? "نبحث عن بياناتك أولاً حتى نحدد الخطوة التالية."
                : "لا تغادر الصفحة حتى تقوم بإدخال الرمز وإتمام التأكيد."}
            </div>

            <div className="mt-4 h-1.5 w-full overflow-hidden rounded-full bg-muted">
              <div className="h-full w-1/2 animate-pulse bg-primary" />
            </div>
          </div>
        </div>
      )}

      <div className="w-full md:w-auto min-h-[70vh] md:min-h-0 flex items-center justify-center md:block px-4 md:px-0">
        <div className="w-full max-w-md md:max-w-none">
          {/* PHONE STEP */}
          {step === "phone" && (
            <form
              onSubmit={handleLookupUser}
              className="
            space-y-4 rounded-2xl bg-card p-6 border border-border
            min-h-[350px] md:min-h-0
            flex flex-col justify-center md:block
          "
            >
              <input
                placeholder="رقم الهاتف"
                value={data.phone}
                onChange={(e) => {
                  setData({ ...data, phone: e.target.value });
                  setExistingUserName("");
                }}
                inputMode="tel"
                autoComplete="tel"
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
                type="submit"
                disabled={!canStartFlow || loading}
                className="w-full rounded-xl py-3 bg-primary text-white disabled:opacity-50"
              >
                {loading
                  ? "جارٍ التحقق..."
                  : isOtpCoolingDown
                    ? `انتظر ${otpCooldownSeconds} ثانية`
                    : "تأكيد الموعد"}
              </button>
            </form>
          )}

          {/* DETAILS STEP */}
          {step === "details" && (
            <form
              onSubmit={handleSendOtpForNewUser}
              className="
            space-y-4 rounded-2xl bg-card p-6 border border-border
            min-h-[350px] md:min-h-0
            flex flex-col justify-center md:block
          "
            >
              <div className="rounded-xl bg-primary/10 px-4 py-3 text-sm text-primary">
                <div>{data.phone}</div>
                {existingUserName && (
                  <div className="mt-1 text-muted-foreground">
                    الاسم الحالي: {existingUserName}
                  </div>
                )}
              </div>

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

              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                <button
                  type="submit"
                  disabled={!canSendOtpForNewUser || loading}
                  className="w-full rounded-xl py-3 bg-primary text-white disabled:opacity-50"
                >
                  {loading
                    ? "جارٍ إرسال الرمز..."
                    : isOtpCoolingDown
                      ? `انتظر ${otpCooldownSeconds} ثانية`
                      : "إرسال رمز التحقق"}
                </button>

                <button
                  type="button"
                  onClick={() => {
                    setStep("phone");
                    setMessage("");
                  }}
                  className="w-full rounded-xl py-3 border border-border text-foreground"
                >
                  تغيير الرقم
                </button>
              </div>
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
              <div className="rounded-xl bg-primary/10 px-4 py-3 text-sm text-primary">
                <div>{data.phone}</div>
                <div className="mt-1 text-muted-foreground">
                  {existingUserName
                    ? `سنستخدم الاسم المسجل: ${existingUserName}`
                    : `${data.firstName} ${data.lastName}`.trim()}
                </div>
              </div>

              <input
                placeholder="أدخل رمز التحقق"
                value={otp}
                onChange={(e) => setOtp(e.target.value)}
                inputMode="numeric"
                autoComplete="one-time-code"
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

              <div className="grid grid-cols-1 gap-3">
                <button
                  type="button"
                  onClick={handleVerifyOTP}
                  disabled={loading}
                  className="w-full rounded-xl py-3 bg-primary text-white disabled:opacity-50"
                >
                  {loading ? "جارٍ التحقق..." : "التحقق وحفظ الموعد"}
                </button>

                <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                  <button
                    type="button"
                    onClick={handleResendOTP}
                    disabled={loading || isOtpCoolingDown}
                    className="w-full rounded-xl py-3 border border-border text-foreground disabled:opacity-50"
                  >
                    {isOtpCoolingDown
                      ? `إعادة الإرسال خلال ${otpCooldownSeconds} ثانية`
                      : "إعادة إرسال الرمز"}
                  </button>

                  <button
                    type="button"
                    onClick={() => {
                      setStep("phone");
                      setConfirmation(null);
                      setOtp("");
                      setExistingUserName("");
                      setMessage("");
                    }}
                    className="w-full rounded-xl py-3 border border-border text-foreground"
                  >
                    تغيير الرقم
                  </button>
                </div>
              </div>
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
