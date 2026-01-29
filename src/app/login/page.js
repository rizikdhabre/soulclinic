"use client";

import { useState } from "react";
import { Shield, Users } from "lucide-react";
import LoginPage from "@/components/ui/LoginPage";
import LoginBox from "@/components/ui/LoginBox";

export default function Login() {
  const [mode, setMode] = useState(null); 

  return (
    <div className="min-h-screen flex items-center justify-center px-4 wellness-gradient">
      <div className="w-full max-w-md">

        {!mode && (
          <div className="glass-card p-6">
            <div className="text-center mb-6" dir="rtl">
              <h2 className="heading-section text-foreground mb-2">
                اختر العملية
              </h2>
              <p className="text-subtle">
                تسجيل دخول الأدمن أو استخراج مواعيد المستخدمين.
              </p>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <button
                onClick={() => setMode("admin")}
                className="
                  group rounded-2xl p-5 text-right transition
                  border border-foreground/10 bg-background/50 backdrop-blur
                  hover:border-primary/30 hover:shadow-elevated
                  focus:outline-none focus:ring-4 focus:ring-primary/15
                "
                dir="rtl"
              >
                <div className="flex items-center justify-between gap-3">
                  <div className="w-11 h-11 rounded-2xl bg-primary/10 flex items-center justify-center">
                    <Shield className="w-6 h-6 text-primary" />
                  </div>
                  <span className="text-foreground font-semibold text-lg">
                    تسجيل دخول الأدمن
                  </span>
                </div>
                <p className="mt-3 text-sm text-subtle">
                  للدخول إلى لوحة الإدارة والتحكم.
                </p>
              </button>

              <button
                onClick={() => setMode("user")}
                className="
                  group rounded-2xl p-5 text-right transition
                  border border-foreground/10 bg-background/50 backdrop-blur
                  hover:border-primary/30 hover:shadow-elevated
                  focus:outline-none focus:ring-4 focus:ring-primary/15
                "
                dir="rtl"
              >
                <div className="flex items-center justify-between gap-3">
                  <div className="w-11 h-11 rounded-2xl bg-primary/10 flex items-center justify-center">
                    <Users className="w-6 h-6 text-primary" />
                  </div>
                  <span className="text-foreground font-semibold text-lg">
                    استخراج المواعيد
                  </span>
                </div>
                <p className="mt-3 text-sm text-subtle">
                  أدخل رقم الهاتف لعرض المواعيد.
                </p>
              </button>
            </div>
          </div>
        )}
        {mode && (
          <div className="glass-card p-6 flex flex-row items-center">
            {mode === "admin" && <LoginBox />}
            {mode === "user" && <LoginPage />}
                        <button
              onClick={() => setMode(null)}
              className="
                mb-4 text-sm font-medium transition
                text-foreground/70 hover:text-foreground
                focus:outline-none focus:ring-4 focus:ring-primary/15
                rounded-xl px-2 py-1
              "
              dir="rtl"
            >
              ← رجوع
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
