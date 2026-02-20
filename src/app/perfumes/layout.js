"use client";

import { usePathname } from "next/navigation";
import Hero3D from "@/components/perfumes/Hero3D";
import { useState } from "react";

export default function PerfumesLayout({ children }) {
  const [introDone, setIntroDone] = useState(false);
  const pathname = usePathname();

  const isHome = pathname === "/perfumes";

  return (
    <div className="relative min-h-screen">
      {/* 3D Hero (only visible on /perfumes) */}
      <div
        className={`transition-opacity duration-500 ${
          isHome
            ? "opacity-100 pointer-events-auto"
            : "opacity-0 pointer-events-none absolute inset-0"
        }`}
      >
        <Hero3D onIntroFinished={() => setIntroDone(true)} />
      </div>
      <div
        className={`transition-opacity duration-500 ${
          isHome && !introDone ? "opacity-0 pointer-events-none" : "opacity-100"
        }`}
      >
        {children}
      </div>
    </div>
  );
}
