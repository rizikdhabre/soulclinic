"use client";
import { motion } from "framer-motion";
import { TrendingUp } from "lucide-react";
import { useState } from "react";

export const AttendanceChart = ({
  rate,
  attended,
  missed,
  upcoming,
  missedAppointments,
}) => {
  const [showMissed, setShowMissed] = useState(false);
  const circumference = 2 * Math.PI * 42;
  const offset = circumference - (rate / 100) * circumference;

  return (
    <div className="bg-card rounded-2xl p-6 flex items-center gap-6">
      {/* Progress Ring */}
      <div className="relative w-24 h-24">
        <svg viewBox="0 0 100 100" className="-rotate-90 w-full h-full">
          {/* Background */}
          <circle
            cx="50"
            cy="50"
            r="42"
            strokeWidth="10"
            fill="none"
            stroke="currentColor"
            className="text-muted"
          />

          {/* Progress */}
          <motion.circle
            cx="50"
            cy="50"
            r="42"
            strokeWidth="10"
            fill="none"
            stroke="currentColor"
            className="text-green-500"
            strokeLinecap="round"
            strokeDasharray={circumference}
            initial={{ strokeDashoffset: circumference }}
            animate={{ strokeDashoffset: offset }}
            transition={{ duration: 0.9, ease: "easeOut" }}
          />
        </svg>

        {/* Percentage */}
        <div className="absolute inset-0 flex items-center justify-center">
          <span className="text-xl font-bold text-foreground">{rate}%</span>
        </div>
      </div>
      <div className="flex flex-col gap-2">
        <h3 className="flex items-center gap-2 font-semibold text-foreground">
          نسبة الحضور
          <TrendingUp className="w-4 h-4 text-success" />
        </h3>

        <p className="text-sm text-muted-foreground">حضور المواعيد</p>
        <div className="flex gap-4 mt-1 text-sm">
          <div className="flex items-center gap-2">
            <span className="w-2.5 h-2.5 rounded-full bg-green-500" />
            <span className="text-foreground">
              {attended} <br />
              حضر
            </span>
          </div>

          <div
            onClick={() => setShowMissed(true)}
            className="flex items-center gap-2 cursor-pointer hover:opacity-80 transition"
          >
            <span className="w-2.5 h-2.5 rounded-full bg-destructive" />
            <span className="text-foreground">
              {missed} <br />
              لم يحضر
            </span>
          </div>

          <div className="flex items-center gap-2">
            <span className="w-2.5 h-2.5 rounded-full bg-muted-foreground" />
            <span className="text-foreground">
              {upcoming} <br />
              لم يأتِ موعدها بعد
            </span>
          </div>
        </div>
      </div>
      {showMissed && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
          <div className="bg-card w-full max-w-xl rounded-2xl p-6 max-h-[80vh] overflow-y-auto space-y-4">
            <div className="flex justify-between items-center">
              <h2 className="text-lg font-semibold">قائمة الذين لم يحضروا</h2>
              <button
                onClick={() => setShowMissed(false)}
                className="text-sm text-muted-foreground hover:text-foreground"
              >
                إغلاق
              </button>
            </div>

            {missedAppointments.length === 0 ? (
              <p className="text-center text-muted-foreground">
                لا يوجد مواعيد فائتة
              </p>
            ) : (
              <div className="space-y-3">
                {missedAppointments.map((item, index) => (
                  <div
                    key={index}
                    className="border rounded-xl p-4 flex justify-between items-center"
                  >
                    <div>
                      <p className="font-medium">{item.fullName}</p>
                      <p className="text-sm text-muted-foreground">
                        {item.date} - {item.time}
                      </p>
                    </div>

                    <span className="text-destructive text-sm font-medium">
                      لم يحضر
                    </span>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
};
