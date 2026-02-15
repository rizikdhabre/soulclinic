"use client";

import { usePathname } from "next/navigation";
import Hero3D from "@/components/perfumes/Hero3D";
export default function PerfumesLayout({ children }) {
  const pathname = usePathname();

  const isHome = pathname === "/perfumes";

  return (
    <div className="relative">
      <div
        className={`transition-opacity duration-500 ${
          isHome
            ? "opacity-100 pointer-events-auto"
            : "opacity-0 pointer-events-none absolute"
        }`}
      >
        <Hero3D />
      </div>

      {children}
    </div>
  );
}
