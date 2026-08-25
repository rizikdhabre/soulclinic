"use client";

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Phone, ShieldCheck, KeyRound } from "lucide-react";
import { usePhoneOtp } from "@/hooks/usePhoneOtp";
import { normalizeIsraeliPhone } from "@/lib/phone";

function getLoginErrorMessage(error) {
  switch (error?.code) {
    case "INVALID_PHONE":
      return "رقم الهاتف غير صحيح. أدخل رقمًا إسرائيليًا صالحًا.";
    case "OTP_RATE_LIMITED":
    case "OTP_SOURCE_RATE_LIMITED":
    case "OTP_FALLBACK_SOURCE_RATE_LIMITED":
    case "auth/too-many-requests":
      return "تم إرسال طلبات كثيرة. انتظر قليلًا ثم حاول مرة أخرى.";
    case "OTP_VERIFY_RATE_LIMITED":
      return "تم إدخال رمز خاطئ عدة مرات. انتظر قبل المحاولة مرة أخرى.";
    case "OTP_SEND_PENDING":
    case "auth/network-request-failed":
      return "قد يكون الرمز في طريقه إليك. انتظر قليلًا قبل المحاولة مرة أخرى.";
    case "OTP_SERVICE_NOT_CONFIGURED":
    case "OTP_SOURCE_UNAVAILABLE":
    case "OTP_PROVIDER_UNSUPPORTED":
    case "auth/app-not-authorized":
    case "auth/invalid-app-credential":
    case "auth/missing-app-credential":
    case "auth/operation-not-allowed":
      return "خدمة التحقق غير متاحة حاليًا. يرجى المحاولة لاحقًا.";
    case "OTP_SEND_FAILED":
    case "OTP_SEND_RETRIES_EXHAUSTED":
    case "OTP_VERIFY_FAILED":
    case "OTP_VERIFY_TEMPORARY_FAILURE":
    case "OTP_CHALLENGE_FAILED":
    case "OTP_REQUEST_IN_PROGRESS":
    case "OTP_STATE_BUSY":
    case "auth/captcha-check-failed":
    case "auth/internal-error":
    case "auth/quota-exceeded":
      return "حدث عطل مؤقت في التحقق. يرجى المحاولة مرة أخرى.";
    case "INVALID_OTP":
    case "OTP_VERIFICATION_INVALID":
    case "auth/invalid-verification-code":
      return "رمز التحقق غير صحيح. حاول مرة أخرى.";
    case "OTP_VERIFICATION_REQUIRED":
    case "auth/missing-verification-code":
      return "أدخل رمز التحقق المرسل إلى هاتفك.";
    case "OTP_VERIFICATION_EXPIRED":
    case "auth/code-expired":
    case "OTP_FLOW_NOT_STARTED":
      return "انتهت صلاحية رمز التحقق. أعد إرسال الرمز وحاول مرة أخرى.";
    default:
      return "تعذر إكمال التحقق. يرجى المحاولة مرة أخرى.";
  }
}

export default function LoginPage() {
  const router = useRouter();

  const [step, setStep] = useState("phone");
  const [rawPhone, setRawPhone] = useState("");
  const [otp, setOtp] = useState("");
  const [localError, setLocalError] = useState("");
  const otpFlow = usePhoneOtp({
    purpose: "login",
    recaptchaContainerId: "login-recaptcha-container",
  });

  const normalizedPhone = useMemo(
    () => normalizeIsraeliPhone(rawPhone),
    [rawPhone],
  );

  const isCoolingDown = otpFlow.cooldownSeconds > 0;
  const canSend = Boolean(
    normalizedPhone && !otpFlow.loading && !isCoolingDown,
  );
  const canVerify = Boolean(
    otp.trim().length >= 6 && !otpFlow.loading,
  );
  const visibleError = localError ||
    (otpFlow.error ? getLoginErrorMessage(otpFlow.error) : "");

  async function handleSendOtp() {
    if (otpFlow.loading || isCoolingDown) return;

    setLocalError("");
    if (!normalizedPhone) {
      setLocalError(getLoginErrorMessage({ code: "INVALID_PHONE" }));
      return;
    }

    try {
      const startOutcome = await otpFlow.start(normalizedPhone);
      if (!startOutcome.started) return;
      setStep("otp");
    } catch {
      // The hook exposes only its projected public error.
    }
  }

  async function handleVerifyOtp() {
    if (!canVerify) return;

    setLocalError("");
    try {
      const completion = await otpFlow.verify(otp.trim());
      if (
        completion?.success === true &&
        completion?.purpose === "login"
      ) {
        router.push("/userAppointments");
        return;
      }
      setLocalError("تعذر إكمال التحقق. يرجى المحاولة مرة أخرى.");
    } catch {
      // The hook exposes only its projected public error.
    }
  }

  async function handleResendOtp() {
    if (otpFlow.loading || isCoolingDown) return;

    setOtp("");
    setLocalError("");
    try {
      await otpFlow.resend();
    } catch {
      setStep("phone");
      // The hook retains its projected public error and cooldown.
    }
  }

  function handleBackToPhone() {
    otpFlow.reset();
    setStep("phone");
    setOtp("");
    setLocalError("");
  }

  return (
    <div dir="rtl" className="w-full">
      <div className="text-center mb-8">
        <h2 className="heading-section text-foreground mb-2">
          استخراج مواعيدك
        </h2>
        <p className="text-subtle">
          أدخل رقم الهاتف، ثم أدخل رمز التحقق للوصول إلى مواعيدك.
        </p>
      </div>

      <div className="glass-card p-7 space-y-6">
        <div id="login-recaptcha-container" />

        {step === "phone" && (
          <>
            <div>
              <label className="block text-sm font-medium text-foreground mb-2">
                رقم الهاتف
              </label>

              <div className="relative">
                <span className="absolute inset-y-0 right-4 flex items-center text-foreground/50">
                  <Phone className="w-5 h-5" />
                </span>

                <input
                  value={rawPhone}
                  onChange={(e) => setRawPhone(e.target.value)}
                  inputMode="tel"
                  autoComplete="tel"
                  placeholder="مثال: 05XXXXXXXX"
                  className="
                    w-full rounded-2xl border border-foreground/10
                    bg-background/60 backdrop-blur
                    px-12 py-4 text-foreground placeholder:text-foreground/40
                    outline-none transition
                    focus:border-primary/40 focus:ring-4 focus:ring-primary/15
                  "
                />
              </div>

              {rawPhone && (
                <p className="mt-2 text-xs text-foreground/60">
                  {normalizedPhone
                    ? `سيتم التحقق من: ${normalizedPhone}`
                    : "صيغة الرقم غير صحيحة."}
                </p>
              )}
            </div>

            {visibleError && (
              <div className="rounded-2xl border border-destructive/20 bg-destructive/10 p-3 text-sm text-foreground">
                {visibleError}
              </div>
            )}

            <Button
              onClick={handleSendOtp}
              disabled={!canSend}
              className="w-full rounded-full py-7 text-xl font-semibold"
            >
              <span className="flex items-center justify-center gap-2">
                <ShieldCheck className="w-5 h-5" />
                {otpFlow.loading
                  ? "جاري الإرسال..."
                  : isCoolingDown
                    ? `انتظر ${otpFlow.cooldownSeconds} ثانية`
                    : "إرسال رمز التحقق"}
              </span>
            </Button>
          </>
        )}

        {step === "otp" && (
          <>
            <div className="text-center">
              <p className="text-subtle">
                تم إرسال رمز إلى رقمك. أدخل الرمز للمتابعة.
              </p>
              <p className="mt-1 text-xs text-foreground/60">
                {normalizedPhone}
              </p>
            </div>

            <div>
              <label className="block text-sm font-medium text-foreground mb-2">
                رمز التحقق (OTP)
              </label>

              <div className="relative">
                <span className="absolute inset-y-0 right-4 flex items-center text-foreground/50">
                  <KeyRound className="w-5 h-5" />
                </span>

                <input
                  value={otp}
                  onChange={(e) => setOtp(e.target.value)}
                  inputMode="numeric"
                  autoComplete="one-time-code"
                  placeholder="••••••"
                  className="
                    w-full rounded-2xl border border-foreground/10
                    bg-background/60 backdrop-blur
                    px-12 py-4 text-foreground placeholder:text-foreground/40
                    outline-none transition
                    focus:border-primary/40 focus:ring-4 focus:ring-primary/15
                  "
                />
              </div>
            </div>

            {visibleError && (
              <div className="rounded-2xl border border-destructive/20 bg-destructive/10 p-3 text-sm text-foreground">
                {visibleError}
              </div>
            )}

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <button
                type="button"
                onClick={handleBackToPhone}
                disabled={otpFlow.loading}
                className="
                  rounded-2xl border border-foreground/10 bg-background/50 backdrop-blur
                  px-4 py-4 text-foreground/80 hover:text-foreground transition
                  focus:outline-none focus:ring-4 focus:ring-primary/15 disabled:opacity-50
                "
              >
                رجوع
              </button>

              <Button
                onClick={handleVerifyOtp}
                disabled={!canVerify}
                className="rounded-2xl py-6 text-lg font-semibold"
              >
                {otpFlow.loading ? "جاري التحقق..." : "تأكيد الرمز"}
              </Button>
            </div>

            <button
              type="button"
              onClick={handleResendOtp}
              className="text-sm text-foreground/70 hover:text-foreground transition"
              disabled={otpFlow.loading || isCoolingDown}
            >
              {isCoolingDown
                ? `إعادة الإرسال خلال ${otpFlow.cooldownSeconds} ثانية`
                : otpFlow.loading
                  ? "جاري الإرسال..."
                  : "إعادة إرسال الرمز"}
            </button>
          </>
        )}
      </div>
    </div>
  );
}
