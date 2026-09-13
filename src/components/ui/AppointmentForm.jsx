"use client";

import { useRef, useState } from "react";
import { Check } from "lucide-react";
import { format } from "date-fns";
import { usePhoneOtp } from "@/hooks/usePhoneOtp";
import { createBookingFormFlow } from "@/lib/bookingFormFlow";
import { normalizeIsraeliPhone } from "@/lib/phone";

function getOtpErrorMessage(error) {
  switch (error?.code) {
    case "INVALID_PHONE":
      return "رقم الهاتف غير صحيح. أدخل رقمًا إسرائيليًا صالحًا.";
    case "OTP_RATE_LIMITED":
      return "يرجى الانتظار قبل طلب رمز جديد لهذا الرقم.";
    case "OTP_SOURCE_RATE_LIMITED":
    case "OTP_SEND_SOURCE_RATE_LIMITED":
      return "تم تجاوز عدد طلبات التحقق من هذه الشبكة مؤقتًا. يرجى الانتظار ثم المحاولة مجددًا.";
    case "OTP_SEND_BUDGET_EXCEEDED":
      return "تم بلوغ الحد اليومي للرسائل. يرجى المحاولة بعد انتهاء مدة الانتظار.";
    case "OTP_PROVIDER_RATE_LIMITED":
      return "خدمة الرسائل تقيّد الطلبات مؤقتًا. يرجى الانتظار ثم المحاولة مجددًا.";
    case "OTP_VERIFY_RATE_LIMITED":
      return "تم إدخال رمز خاطئ عدة مرات. انتظر قبل المحاولة مرة أخرى.";
    case "OTP_SEND_PENDING":
      return "لم نتمكن من تأكيد إرسال الرمز بعد. أعد التحقق من حالة الإرسال.";
    case "OTP_SERVICE_NOT_CONFIGURED":
    case "OTP_RATE_LIMIT_CONFIG_INVALID":
    case "OTP_SOURCE_UNAVAILABLE":
    case "OTP_PROVIDER_UNSUPPORTED":
      return "خدمة التحقق غير متاحة حاليًا. يرجى المحاولة لاحقًا.";
    case "OTP_SEND_FAILED":
    case "OTP_SEND_TEMPORARY_FAILURE":
    case "OTP_PROVIDER_REJECTED":
    case "OTP_SEND_RETRIES_EXHAUSTED":
      return "تعذر تأكيد إرسال رمز التحقق عبر خدمة الرسائل. أعد محاولة الإرسال بعد انتهاء الانتظار.";
    case "OTP_PERSISTENCE_FAILED":
      return "تعذر حفظ حالة التحقق. أعد المحاولة بنفس الطلب.";
    case "OTP_CHALLENGE_FAILED":
    case "OTP_CHALLENGE_EXPIRED":
      return "طلب التحقق غير متاح أو انتهت صلاحيته. اطلب رمزًا جديدًا بعد انتهاء الانتظار.";
    case "OTP_COMPLETION_IN_PROGRESS":
      return "يجري إكمال التحقق حاليًا. أعد تأكيد الرمز بعد قليل.";
    case "OTP_VERIFY_FAILED":
    case "OTP_VERIFY_TEMPORARY_FAILURE":
    case "OTP_REQUEST_IN_PROGRESS":
    case "OTP_STATE_BUSY":
      return "حدث عطل مؤقت في التحقق. أعد تأكيد الرمز نفسه.";
    case "INVALID_OTP":
    case "OTP_VERIFICATION_INVALID":
      return "رمز التحقق غير صحيح. حاول مرة أخرى.";
    case "OTP_VERIFICATION_REQUIRED":
      return "أدخل رمز التحقق المرسل إلى هاتفك.";
    case "OTP_VERIFICATION_EXPIRED":
    case "OTP_FLOW_NOT_STARTED":
      return "انتهت صلاحية رمز التحقق. أعد إرسال الرمز وحاول مرة أخرى.";
    default:
      return "تعذر إكمال التحقق. يرجى المحاولة مرة أخرى.";
  }
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
  const [bookingStep, setStep] = useState("phone");
  const [otp, setOtp] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [message, setMessage] = useState("");
  const [messageType, setMessageType] = useState("info");
  const bookingFlowRef = useRef(null);
  if (!bookingFlowRef.current) {
    bookingFlowRef.current = createBookingFormFlow();
  }
  const bookingFlow = bookingFlowRef.current;
  const [verifiedFlowState, setVerifiedFlowState] = useState(() =>
    bookingFlow.getSnapshot(),
  );
  const otpFlow = usePhoneOtp({
    purpose: "booking",
  });

  const step = bookingStep === "phone" || bookingStep === "otp"
    ? (otpFlow.phase === "code" || otpFlow.phase === "complete" ? "otp" : "phone")
    : bookingStep;

  const normalizedPhone = normalizeIsraeliPhone(data.phone);
  const isSendCooldownBlocking = otpFlow.cooldownSeconds > 0 && !otpFlow.canRetrySend;
  const canStartFlow = Boolean(
    selectedDate &&
      selectedTime &&
      data.phone.trim() &&
      !otpFlow.loading &&
      !isSendCooldownBlocking,
  );
  const canSubmitDetails = Boolean(
    selectedDate &&
      selectedTime &&
      data.firstName.trim() &&
      data.lastName.trim() &&
      verifiedFlowState.hasPendingBooking &&
      verifiedFlowState.profileStatus === "incomplete" &&
      !submitting,
  );
  const canRetryVerifiedBooking = Boolean(
    selectedDate &&
      selectedTime &&
      normalizedPhone &&
      verifiedFlowState.hasPendingBooking &&
      verifiedFlowState.profileStatus === "complete" &&
      !submitting,
  );
  const visibleMessage = message ||
    (otpFlow.error ? getOtpErrorMessage(otpFlow.error) : "");
  const visibleMessageType = message ? messageType : "error";

  const showMessage = (type, text) => {
    setMessageType(type);
    setMessage(text);
  };

  const syncVerifiedFlowState = () => {
    setVerifiedFlowState(bookingFlow.getSnapshot());
  };

  const submitVerifiedBooking = async (details) => {
    if (submitting || bookingFlow.getSnapshot().submitting) return false;

    setSubmitting(true);
    try {
      const result = await bookingFlow.submit({ onSubmit, details });
      syncVerifiedFlowState();

      if (result.status === "success") {
        setStep("success");
        return true;
      }

      if (result.status === "retry" && result.reason === "error") {
        showMessage("error", "تعذر حفظ الموعد. يرجى المحاولة مرة أخرى.");
      } else if (result.status === "missing") {
        showMessage("error", "انتهت صلاحية التحقق. اطلب رمز تحقق جديدًا.");
      }

      return false;
    } finally {
      setSubmitting(false);
    }
  };

  const handlePhoneSubmit = async (event) => {
    event.preventDefault();
    if (otpFlow.loading || submitting || isSendCooldownBlocking) return;

    if (!selectedDate || !selectedTime) {
      showMessage("error", "اختر التاريخ والساعة قبل تأكيد الموعد.");
      return;
    }
    if (!normalizedPhone) {
      showMessage("error", "رقم الهاتف غير صالح.");
      return;
    }

    setData((current) => ({
      ...current,
      phone: normalizedPhone,
      firstName: "",
      lastName: "",
    }));
    bookingFlow.phoneChanged();
    syncVerifiedFlowState();
    setOtp("");
    setMessage("");

    try {
      const startOutcome = await otpFlow.start(normalizedPhone);
      if (!startOutcome.started) return;
      setStep("otp");
    } catch {
      // The hook exposes only its projected public error.
    }
  };

  const handleResendOtp = async () => {
    if (otpFlow.loading || submitting || isSendCooldownBlocking) return;

    setOtp("");
    setMessage("");
    try {
      await otpFlow.resend();
    } catch {
      // Keep the prepared challenge and projected error available for manual retry.
    }
  };

  const handleVerifyOtp = async () => {
    if (!otp.trim() || otpFlow.loading || submitting) return;

    setMessage("");
    try {
      const completion = await otpFlow.verify(otp.trim());
      if (!completion) return;

      const transition = bookingFlow.acceptCompletion({
        completion,
        bookingData: data,
        normalizedPhone,
      });
      syncVerifiedFlowState();

      if (
        transition.status === "invalid" ||
        transition.status === "pending"
      ) {
        showMessage("error", "تعذر إكمال التحقق. يرجى المحاولة مرة أخرى.");
        return;
      }

      if (transition.status === "details") {
        setData((current) => ({
          ...current,
          firstName: "",
          lastName: "",
        }));
        setStep("details");
        showMessage("info", "أدخل الاسم الأول واسم العائلة لإكمال الحجز.");
        return;
      }

      setStep("retry");
      await submitVerifiedBooking();
    } catch {
      // The hook exposes only its projected public error.
    }
  };

  const handleDetailsSubmit = async (event) => {
    event.preventDefault();
    if (submitting || bookingFlow.getSnapshot().submitting) return;

    const firstName = data.firstName.trim();
    const lastName = data.lastName.trim();
    if (!firstName || !lastName) {
      showMessage("error", "أدخل الاسم الأول واسم العائلة.");
      return;
    }
    if (!selectedDate || !selectedTime) {
      showMessage("error", "اختر التاريخ والساعة قبل حفظ الموعد.");
      return;
    }
    if (!normalizedPhone || !verifiedFlowState.hasPendingBooking) {
      showMessage("error", "انتهت صلاحية التحقق. اطلب رمز تحقق جديدًا.");
      return;
    }

    setData((current) => ({ ...current, firstName, lastName }));
    setMessage("");
    await submitVerifiedBooking({ firstName, lastName });
  };

  const handleRetryBooking = async () => {
    if (submitting || bookingFlow.getSnapshot().submitting) return;
    if (!selectedDate || !selectedTime) {
      showMessage("error", "اختر التاريخ والساعة قبل حفظ الموعد.");
      return;
    }
    if (!normalizedPhone || !verifiedFlowState.hasPendingBooking) {
      showMessage("error", "انتهت صلاحية التحقق. اطلب رمز تحقق جديدًا.");
      return;
    }

    setMessage("");
    await submitVerifiedBooking();
  };

  const returnToPhone = () => {
    otpFlow.reset();
    bookingFlow.reset();
    syncVerifiedFlowState();
    setStep("phone");
    setOtp("");
    setData((current) => ({
      ...current,
      firstName: "",
      lastName: "",
    }));
    setMessage("");
  };

  return (
    <>
      <div id={otpFlow.recaptchaContainerId} />

      <div className="w-full md:w-auto min-h-[70vh] md:min-h-0 flex items-center justify-center md:block px-4 md:px-0">
        <div className="w-full max-w-md md:max-w-none">
          {otpFlow.statusMessage && (
            <p role="status" aria-live="polite" className="mb-3 text-sm text-muted-foreground" dir="rtl">
              {otpFlow.statusMessage}
            </p>
          )}
          {step === "phone" && (
            <form
              onSubmit={handlePhoneSubmit}
              className="
                space-y-4 rounded-2xl bg-card p-6 border border-border
                min-h-[350px] md:min-h-0
                flex flex-col justify-center md:block
              "
            >
              <input
                placeholder="رقم الهاتف"
                value={data.phone}
                onChange={(event) => {
                  const changedPhone = otpFlow.setPhone(event.target.value);
                  setData((current) => ({
                    ...current,
                    phone: event.target.value,
                    firstName: "",
                    lastName: "",
                  }));
                  if (changedPhone) {
                    bookingFlow.phoneChanged();
                    syncVerifiedFlowState();
                    setOtp("");
                  }
                  setMessage("");
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

              {visibleMessage && (
                <div
                  className={`rounded-xl px-4 py-3 text-sm ${
                    visibleMessageType === "error"
                      ? "bg-red-500/10 text-red-600"
                      : "bg-primary/10 text-primary"
                  }`}
                >
                  {visibleMessage}
                </div>
              )}

              {bookingError && (
                <div className="rounded-xl bg-red-500/10 text-red-600 px-4 py-3 text-sm">
                  {bookingError}
                </div>
              )}

              <button
                type="submit"
                disabled={!canStartFlow || submitting}
                className="w-full rounded-xl py-3 bg-primary text-white disabled:opacity-50"
              >
                {otpFlow.loading
                  ? "جارٍ إرسال الرمز..."
                  : isSendCooldownBlocking
                    ? `انتظر ${otpFlow.cooldownSeconds} ثانية`
                    : otpFlow.canRetrySend
                      ? "التحقق من حالة الإرسال"
                      : "تأكيد الموعد"}
              </button>
            </form>
          )}

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
                  أدخل رمز التحقق الذي تم إرساله إلى رقمك.
                </div>
              </div>

              <input
                placeholder="أدخل رمز التحقق"
                value={otp}
                onChange={(event) => setOtp(event.target.value)}
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
                onChange={(event) =>
                  setData((current) => ({
                    ...current,
                    note: event.target.value,
                  }))
                }
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

              {visibleMessage && (
                <div
                  className={`rounded-xl px-4 py-3 text-sm ${
                    visibleMessageType === "error"
                      ? "bg-red-500/10 text-red-600"
                      : "bg-primary/10 text-primary"
                  }`}
                >
                  {visibleMessage}
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
                  onClick={handleVerifyOtp}
                  disabled={!otp.trim() || otpFlow.loading || submitting}
                  className="w-full rounded-xl py-3 bg-primary text-white disabled:opacity-50"
                >
                  {otpFlow.loading || submitting
                    ? "جارٍ التحقق..."
                    : "التحقق وحفظ الموعد"}
                </button>

                <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                  <button
                    type="button"
                    onClick={handleResendOtp}
                    disabled={
                      otpFlow.loading || submitting || isSendCooldownBlocking
                    }
                    className="w-full rounded-xl py-3 border border-border text-foreground disabled:opacity-50"
                  >
                    {isSendCooldownBlocking
                      ? `إعادة الإرسال خلال ${otpFlow.cooldownSeconds} ثانية`
                      : otpFlow.canRetrySend
                        ? "التحقق من حالة الإرسال"
                        : "إعادة إرسال الرمز"}
                  </button>

                  <button
                    type="button"
                    onClick={returnToPhone}
                    disabled={otpFlow.loading || submitting}
                    className="w-full rounded-xl py-3 border border-border text-foreground disabled:opacity-50"
                  >
                    تغيير الرقم
                  </button>
                </div>
              </div>
            </div>
          )}

          {step === "retry" && (
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
                  تم التحقق من الرقم. أعد محاولة حفظ الموعد.
                </div>
              </div>

              {visibleMessage && (
                <div
                  className={`rounded-xl px-4 py-3 text-sm ${
                    visibleMessageType === "error"
                      ? "bg-red-500/10 text-red-600"
                      : "bg-primary/10 text-primary"
                  }`}
                >
                  {visibleMessage}
                </div>
              )}

              {bookingError && (
                <div className="rounded-xl bg-red-500/10 text-red-600 px-4 py-3 text-sm">
                  {bookingError}
                </div>
              )}

              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                <button
                  type="button"
                  onClick={handleRetryBooking}
                  disabled={!canRetryVerifiedBooking}
                  className="w-full rounded-xl py-3 bg-primary text-white disabled:opacity-50"
                >
                  {submitting
                    ? "جارٍ حفظ الموعد..."
                    : "إعادة محاولة حفظ الموعد"}
                </button>

                <button
                  type="button"
                  onClick={returnToPhone}
                  disabled={submitting}
                  className="w-full rounded-xl py-3 border border-border text-foreground disabled:opacity-50"
                >
                  تغيير الرقم
                </button>
              </div>
            </div>
          )}

          {step === "details" && (
            <form
              onSubmit={handleDetailsSubmit}
              className="
                space-y-4 rounded-2xl bg-card p-6 border border-border
                min-h-[350px] md:min-h-0
                flex flex-col justify-center md:block
              "
            >
              <div className="rounded-xl bg-primary/10 px-4 py-3 text-sm text-primary">
                <div>{data.phone}</div>
                <div className="mt-1 text-muted-foreground">
                  تم التحقق من الرقم. أكمل الاسم لحفظ الموعد.
                </div>
              </div>

              <input
                placeholder="الاسم الأول"
                value={data.firstName}
                onChange={(event) =>
                  setData((current) => ({
                    ...current,
                    firstName: event.target.value,
                  }))
                }
                required
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
                onChange={(event) =>
                  setData((current) => ({
                    ...current,
                    lastName: event.target.value,
                  }))
                }
                required
                className="
                  w-full rounded-xl border px-4 py-3
                  bg-background text-foreground
                  placeholder:text-muted-foreground
                  border-border
                  focus:outline-none focus:ring-2 focus:ring-primary/40
                "
              />

              {visibleMessage && (
                <div
                  className={`rounded-xl px-4 py-3 text-sm ${
                    visibleMessageType === "error"
                      ? "bg-red-500/10 text-red-600"
                      : "bg-primary/10 text-primary"
                  }`}
                >
                  {visibleMessage}
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
                  disabled={!canSubmitDetails}
                  className="w-full rounded-xl py-3 bg-primary text-white disabled:opacity-50"
                >
                  {submitting ? "جارٍ حفظ الموعد..." : "حفظ الموعد"}
                </button>

                <button
                  type="button"
                  onClick={returnToPhone}
                  disabled={submitting}
                  className="w-full rounded-xl py-3 border border-border text-foreground disabled:opacity-50"
                >
                  تغيير الرقم
                </button>
              </div>
            </form>
          )}

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
