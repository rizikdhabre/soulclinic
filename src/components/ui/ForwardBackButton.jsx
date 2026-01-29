"use client";

import { ArrowLeft } from "lucide-react";

export default function ForwardBackButton({ onClick }) {
  return (
    <button
      onClick={onClick}
      aria-label="Open treatment"
      className="
        flex items-center justify-center
        w-9 h-9 md:w-10 md:h-10
        rounded-full
        bg-emerald-400/80
        text-black
        shadow-md
        hover:scale-105
        active:scale-95
        transition
      "
    >
      <ArrowLeft size={18} />
    </button>
  );
}
