"use client";

import dynamic from "next/dynamic";
import { useCallback, useState, useEffect } from "react";

const Scene = dynamic(() => import("./Scene"), {
  ssr: false,
});

export default function Hero3D() {
  const [isScrolled, setIsScrolled] = useState(false);

  useEffect(() => {
    const handleScroll = () => {
      setIsScrolled(window.scrollY > 20);
    };

    window.addEventListener("scroll", handleScroll);

    return () => {
      window.removeEventListener("scroll", handleScroll);
    };
  }, []);

  const scrollToPerfumes = useCallback(() => {
    const section = document.getElementById("perfume-categories");
    if (section) {
      section.scrollIntoView({ behavior: "smooth" });
    }
  }, []);

  return (
    <section className="relative w-full h-screen overflow-hidden bg-[radial-gradient(circle_at_center,_rgba(15,42,35,0.95)_0%,_rgba(8,20,16,1)_55%,_#000_100%)]">
      {/* Scroll Indicator */}
      <div
        onClick={scrollToPerfumes}
        className={`absolute left-1/2 -translate-x-1/2 flex flex-col items-center gap-3 cursor-pointer group z-50 ${
          isScrolled ? "top-[4rem]" : "top-[6rem]"
        }`}
      >
        <span className="text-sm tracking-widest uppercase text-gold opacity-80 group-hover:opacity-100 transition">
          اضغط لعرض العطور
        </span>

        <div className="animate-bounce">
          <div className="w-8 h-8 border-b-2 border-r-2 border-gold rotate-45" />
        </div>
      </div>
      {/* Gold Glow */}
      <div className="absolute inset-0 pointer-events-none bg-[radial-gradient(circle_at_center,_rgba(212,175,55,0.08)_0%,_transparent_60%)]" />

      {/* 3D Scene */}
      <Scene />
    </section>
  );
}
