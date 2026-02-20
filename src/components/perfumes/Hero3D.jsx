"use client";

import dynamic from "next/dynamic";
import { useCallback, useState, useEffect } from "react";

const Scene = dynamic(() => import("./Scene"), {
  ssr: false,
});

export default function Hero3D({ onIntroFinished }) {
  const [isScrolled, setIsScrolled] = useState(false);
  const [sceneReady, setSceneReady] = useState(false);

  useEffect(() => {
    if (sceneReady && onIntroFinished) {
      onIntroFinished();
    }
  }, [sceneReady, onIntroFinished]);

  useEffect(() => {
    const handleScroll = () => {
      setIsScrolled(window.scrollY > 20);
    };

    window.addEventListener("scroll", handleScroll);
    return () => window.removeEventListener("scroll", handleScroll);
  }, []);

  useEffect(() => {
    if (!sceneReady) {
      document.body.style.overflow = "hidden";
    } else {
      document.body.style.overflow = "auto";
      window.scrollTo(0, 0);
    }

    return () => {
      document.body.style.overflow = "auto";
    };
  }, [sceneReady]);

  const scrollToPerfumes = useCallback(() => {
    const section = document.getElementById("perfume-categories");
    if (section) {
      section.scrollIntoView({ behavior: "smooth" });
    }
  }, []);

  return (
    <section className="relative w-full h-screen overflow-hidden bg-[radial-gradient(circle_at_center,_rgba(15,42,35,0.95)_0%,_rgba(8,20,16,1)_55%,_#000_100%)]">
      {sceneReady && (
        <>
          {" "}
          {/* Scroll Indicator */}
          <div
            className={`absolute left-1/2 -translate-x-1/2 flex flex-col items-center gap-8 z-50 ${
              isScrolled ? "top-[4rem]" : "top-[6rem]"
            }`}
          >
            <div className="animate-bounce">
              <div className="w-8 h-8 border-b-2 border-r-2 border-gold rotate-45" />
            </div>

            <button
              onClick={scrollToPerfumes}
              className="px-8 py-3 border-2 border-gold text-gold uppercase tracking-widest text-sm font-semibold hover:bg-gold hover:text-black transition-all duration-300 group"
            >
              اضغط لعرض العطور
            </button>
          </div>
          {/* Gold Glow */}
          <div className="absolute inset-0 pointer-events-none bg-[radial-gradient(circle_at_center,_rgba(212,175,55,0.08)_0%,_transparent_60%)]" />
        </>
      )}
      {/* 3D Scene */}
      <Scene onReady={() => setSceneReady(true)} />
    </section>
  );
}
