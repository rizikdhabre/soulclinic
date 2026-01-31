"use client";

import { useState } from "react";

import AdminProfileCard from "@/components/admin/AdminProfileCard";
import ChangePasswordModal from "@/components/admin/ChangePasswordModal";
import DailyCalendar from "@/components/admin/DailyCalendar";
import HujamahStatsCard from "@/components/admin/HujamahStatsCard";
import IncomeStatsCard from "@/components/admin/IncomeStatsCard";
import HeroImageUploader from "@/components/admin/HeroImageUploader";

export default function AdminProfilePage() {
  const [openPassword, setOpenPassword] = useState(false);

  return (
    <div className="min-h-screen relative overflow-hidden bg-background text-foreground">
      {/* subtle background glow */}
      <div className="pointer-events-none absolute inset-0">
        <div className="absolute -top-40 -right-40 w-[700px] h-[700px] rounded-full bg-primary/10 blur-3xl" />
        <div className="absolute -bottom-40 -left-40 w-[700px] h-[700px] rounded-full bg-primary/10 blur-3xl" />
      </div>

      <div className="relative max-w-7xl mx-auto px-6 py-14 space-y-16">
        {/* PAGE HEADER */}
        <header className="space-y-2 mt-20">
          <h1 className="text-3xl md:text-4xl font-semibold">
            الملف الشخصي للمشرف
          </h1>
        </header>

        {/* PROFILE ROW */}
        <section className="flex flex-col lg:flex-row lg:items-center lg:justify-between gap-8">
          <AdminProfileCard onChangePassword={() => setOpenPassword(true)} />
        </section>

        <section>
          <HeroImageUploader />
        </section>

        {/* DAILY + STATS */}
        <section className="grid grid-cols-1 lg:grid-cols-[2fr_1fr] gap-12 items-start">
          <div>
            <DailyCalendar />
          </div>

          <div>
            <HujamahStatsCard />
            <IncomeStatsCard />
          </div>
        </section>
      </div>

      {/* CHANGE PASSWORD MODAL */}
      <ChangePasswordModal
        isOpen={openPassword}
        onClose={() => setOpenPassword(false)}
      />
    </div>
  );
}
