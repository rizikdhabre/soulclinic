"use client";

import { useState } from "react";
import { motion } from "framer-motion";
import { User, Lock } from "lucide-react";
import axios from "axios";
import NeonLoader from "@/components/ui/loading";
import { useRouter } from "next/navigation";
export default function LoginBox() {
  const [glow, setGlow] = useState(true);
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const MIN_LOADING_TIME = 400;
  const router = useRouter();
  const handleLogin = async () => {
    if (loading) return;
    setError("");
    setLoading(true);

    const startTime = Date.now();

    try {
      await Promise.all([
        axios.post(
          "/api/loginAdmin",
          { username, password },
          { withCredentials: true },
        ),
        new Promise((resolve) => setTimeout(resolve, MIN_LOADING_TIME)),
      ]);

      router.replace("/admin");
    } catch (err) {
      const elapsed = Date.now() - startTime;
      if (elapsed < MIN_LOADING_TIME) {
        await new Promise((resolve) =>
          setTimeout(resolve, MIN_LOADING_TIME - elapsed),
        );
      }
      setError(err.response?.data?.message || "Invalid credentials");
      setLoading(false);
    }
  };
  return (
    <div className="relative  overflow-visible flex items-center justify-center min-h-screen bg-background overflow-hidden">
      {/* Top accent (soft, not neon) */}
      <div className="absolute top-0 left-1/2 -translate-x-1/2 w-[420px] h-[6px] bg-primary/40 rounded-full blur-md" />

      <motion.div
        initial={{ opacity: 0, scale: 0.95, y: 30 }}
        animate={{ opacity: 1, scale: 1, y: 0 }}
        transition={{ duration: 0.6 }}
        className="
          relative w-[400px] rounded-2xl
          bg-card p-10 shadow-xl border border-border
        "
      >
        {/* Glow toggle */}
        <div
          className="
              flex justify-center mb-6
              md:absolute md:top-6 md:-right-20
              md:mb-0
            "
        >
          <button
            onClick={() => setGlow(!glow)}
            className="relative w-14 h-28 rounded-xl bg-card border border-border"
          >
            <motion.div
              layout
              transition={{ type: "spring", stiffness: 300 }}
              className={`
        absolute left-1/2 -translate-x-1/2 w-9 h-9 rounded-lg
        ${glow ? "top-16 bg-primary shadow-lg" : "top-2 bg-muted"}
      `}
            />

            <span className="absolute top-3 left-1/2 -translate-x-1/2 text-xs text-muted-foreground">
              OFF
            </span>

            <span
              className={`
        absolute bottom-3 left-1/2 -translate-x-1/2 text-xs
        ${glow ? "text-primary" : "text-muted-foreground"}
      `}
            >
              ON
            </span>
          </button>
        </div>

        {/* Light beam (subtle) */}
        <motion.div
          animate={{ top: glow ? "-70%" : "-200%" }}
          className="
            pointer-events-none absolute left-0 w-full h-[900px]
            bg-gradient-to-b from-primary/15 to-transparent
            clip-[polygon(25%_0,75%_0,100%_100%,0_100%)]
          "
        />

        {/* Title */}
        <h2
          className={`
            text-3xl font-serif text-center mb-8 transition
            ${glow ? "text-primary" : "text-foreground"}
          `}
        >
          مرحبًا بعودتك
        </h2>

        {/* Username */}
        <Input
          icon={<User size={18} />}
          label="اسم المستخدم"
          glow={glow}
          type="text"
          value={username}
          onChange={(e) => setUsername(e.target.value)}
        />

        {/* Password */}
        <Input
          icon={<Lock size={18} />}
          label="كلمة المرور"
          glow={glow}
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
        />

        {error && (
          <motion.p
            initial={{ opacity: 0, y: -5 }}
            animate={{ opacity: 1, y: 0 }}
            className="mb-4 text-sm text-red-500 text-center"
          >
            {error}
          </motion.p>
        )}

        {/* Button */}
        {loading ? (
          <div className="w-full h-11 flex items-center justify-center rounded-full bg-black overflow-hidden">
            <NeonLoader width={180} height={44} />
          </div>
        ) : (
          <button
            onClick={handleLogin}
            className={`
      w-full h-11 rounded-full font-medium transition
      ${
        glow
          ? "bg-primary text-primary-foreground shadow-md"
          : "bg-foreground text-background"
      }
    `}
          >
            تسجيل الدخول
          </button>
        )}
      </motion.div>
    </div>
  );
}
function Input({ label, icon, glow, type = "text", value, onChange }) {
  const isFilled = value && value.length > 0;

  return (
    <div className="relative mb-7">
      <input
        type={type}
        value={value}
        onChange={onChange}
        className={`
          peer w-full h-12 bg-transparent border-b outline-none
          pr-8 transition
          ${
            glow
              ? "border-primary text-foreground"
              : "border-border text-foreground"
          }
          focus:border-primary
        `}
      />

      <label
        className={`
          absolute left-1 transition-all pointer-events-none
          ${isFilled ? "-top-2 text-xs" : "top-1/2 -translate-y-1/2 text-sm"}
          peer-focus:-top-2 peer-focus:text-xs
          ${glow ? "text-primary" : "text-muted-foreground"}
        `}
      >
        {label}
      </label>

      <span
        className={`
          absolute right-1 top-1/2 -translate-y-1/2 transition
          ${glow ? "text-primary" : "text-muted-foreground"}
        `}
      >
        {icon}
      </span>
    </div>
  );
}
