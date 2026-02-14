"use client";

import dynamic from "next/dynamic";

const Scene = dynamic(() => import("./Scene"), {
  ssr: false,
});

export default function Hero3D() {
  return (
    <section className="relative w-full h-screen overflow-hidden bg-[radial-gradient(circle_at_center,_rgba(15,42,35,0.95)_0%,_rgba(8,20,16,1)_55%,_#000_100%)]">
      <div className="absolute inset-0 pointer-events-none bg-[radial-gradient(circle_at_center,_rgba(212,175,55,0.08)_0%,_transparent_60%)]" />
      <Scene />
    </section>
  );
}
