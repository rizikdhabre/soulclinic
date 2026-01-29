"use client";

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Phone, ShieldCheck, KeyRound } from "lucide-react";
import { normalizeIsraeliPhone } from "@/lib/phone";
import { sendOTP } from "@/lib/phoneAuth";

export default function LoginPage() {
  const router = useRouter();

  const [step, setStep] = useState("phone");
  const [rawPhone, setRawPhone] = useState("");
  const [otp, setOtp] = useState("");

  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  const normalizedPhone = useMemo(
    () => normalizeIsraeliPhone(rawPhone),
    [rawPhone]
  );

  const canSend = !!normalizedPhone && !loading;
  const canVerify = otp.trim().length >= 6 && !loading;

  async function handleSendOtp() {
    setError("");
    if (!normalizedPhone) {
      setError("رقم الهاتف غير صحيح. أدخل رقم إسرائيلي بصيغة 05XXXXXXXX.");
      return;
    }

    try {
      setLoading(true);
      const confirmation = await sendOTP(normalizedPhone);
      window.__otpConfirmation = confirmation;
      setStep("otp");
    } catch (e) {
      console.error(e);
      setError("فشل إرسال الرمز. جرّب مرة أخرى.");
    } finally {
      setLoading(false);
    }
  }

  async function handleVerifyOtp() {
    setError("");
    try {
      setLoading(true);

      const confirmation = window.__otpConfirmation;
      if (!confirmation) {
        setError("جلسة التحقق انتهت. أعد إرسال الرمز.");
        setStep("phone");
        return;
      }

      await confirmation.confirm(otp.trim());
      router.push(`/userAppointments?phone=${encodeURIComponent(normalizedPhone)}`);

    } catch (e) {
      console.error(e);
      setError("رمز غير صحيح. حاول مرة أخرى.");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div dir="rtl" className="w-full">
      <div className="text-center mb-8">
        <h2 className="heading-section text-foreground mb-2">استخراج مواعيدك</h2>
        <p className="text-subtle">
          أدخل رقم الهاتف، ثم أدخل رمز التحقق للوصول إلى مواعيدك.
        </p>
      </div>

      <div className="glass-card p-7 space-y-6">
        <div id="recaptcha-container" />

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

            {error && (
              <div className="rounded-2xl border border-destructive/20 bg-destructive/10 p-3 text-sm text-foreground">
                {error}
              </div>
            )}

            <Button
              onClick={handleSendOtp}
              disabled={!canSend}
              className="w-full rounded-full py-7 text-xl font-semibold"
            >
              <span className="flex items-center justify-center gap-2">
                <ShieldCheck className="w-5 h-5" />
                {loading ? "جاري الإرسال..." : "إرسال رمز التحقق"}
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
              <p className="mt-1 text-xs text-foreground/60">{normalizedPhone}</p>
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

            {error && (
              <div className="rounded-2xl border border-destructive/20 bg-destructive/10 p-3 text-sm text-foreground">
                {error}
              </div>
            )}

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <button
                type="button"
                onClick={() => {
                  setStep("phone");
                  setOtp("");
                  setError("");
                }}
                className="
                  rounded-2xl border border-foreground/10 bg-background/50 backdrop-blur
                  px-4 py-4 text-foreground/80 hover:text-foreground transition
                  focus:outline-none focus:ring-4 focus:ring-primary/15
                "
              >
                رجوع
              </button>

              <Button
                onClick={handleVerifyOtp}
                disabled={!canVerify}
                className="rounded-2xl py-6 text-lg font-semibold"
              >
                {loading ? "جاري التحقق..." : "تأكيد الرمز"}
              </Button>
            </div>

            <button
              type="button"
              onClick={handleSendOtp}
              className="text-sm text-foreground/70 hover:text-foreground transition"
              disabled={loading}
            >
              إعادة إرسال الرمز
            </button>
          </>
        )}
      </div>
    </div>
  );
}
