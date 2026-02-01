"use client";

import { useState } from "react";
import axios from "axios";
import { format } from "date-fns";
import NeonLoader from "../ui/loading";

const DEFAULT_SLOTS = (() => {
  const slots = [];
  for (let h = 10; h < 20; h++) {
    for (let m = 0; m < 60; m += 30) {
      slots.push(`${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`);
    }
  }
  return slots;
})();

export default function MonthlyBlocker() {
  const [month, setMonth] = useState(format(new Date(), "yyyy-MM"));
  const [selectedTimes, setSelectedTimes] = useState([]);
  const [loading, setLoading] = useState(false);
  const [successMessage, setSuccessMessage] = useState("");

  const toggleTime = (time) => {
    if (loading) return;

    setSelectedTimes((prev) =>
      prev.includes(time)
        ? prev.filter((t) => t !== time)
        : [...prev, time],
    );
  };

  const handleBlockMonth = async () => {
    if (!selectedTimes.length || loading) return;

    try {
      setLoading(true);
      setSuccessMessage(""); 

      await axios.post("/api/appointments/block-month", {
        month,
        times: selectedTimes,
      });

      setSuccessMessage("تم حظر الأوقات المحددة على مدار الشهر بالكامل");

      setTimeout(() => {
        setSuccessMessage("");
      }, 5000);
    } catch (err) {
      console.error(err);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="card-elevated p-6 space-y-4 relative">
      <h3 className="text-lg font-semibold">
        حظر أوقات لشهر كامل
      </h3>

      <input
        type="month"
        value={month}
        disabled={loading}
        onChange={(e) => setMonth(e.target.value)}
        className="border rounded px-3 py-2 bg-background disabled:opacity-50"
      />

    
      <div className="grid grid-cols-4 gap-2">
        {DEFAULT_SLOTS.map((time) => {
          const active = selectedTimes.includes(time);

          return (
            <button
              key={time}
              disabled={loading}
              onClick={() => toggleTime(time)}
              className={`px-2 py-1 rounded text-sm transition
                ${
                  active
                    ? "bg-primary text-primary-foreground"
                    : "bg-secondary hover:bg-secondary/80"
                }
                disabled:opacity-40 disabled:cursor-not-allowed
              `}
            >
              {time}
            </button>
          );
        })}
      </div>

      {successMessage && (
        <div className="rounded-xl border border-primary/30 bg-primary/10 px-4 py-3 text-sm text-primary">
          {successMessage}
        </div>
      )}


      <button
        disabled={loading || !selectedTimes.length}
        onClick={handleBlockMonth}
        className="px-4 py-2 rounded-xl bg-destructive text-destructive-foreground
                   disabled:opacity-50 disabled:cursor-not-allowed"
      >
        {loading ? "جارٍ التنفيذ..." : "حظر الأوقات للشهر"}
      </button>

      {loading && (
        <div className="absolute inset-0 bg-background/60 backdrop-blur-sm flex items-center justify-center rounded-xl">
          <NeonLoader />
        </div>
      )}
    </div>
  );
}
