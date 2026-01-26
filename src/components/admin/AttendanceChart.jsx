import { motion } from "framer-motion";
import { TrendingUp } from "lucide-react";

export const AttendanceChart = ({ rate, attended, total }) => {
  const circumference = 2 * Math.PI * 42;
  const offset = circumference - (rate / 100) * circumference;
  const missed = total - attended;

  return (
    <div className="bg-card rounded-2xl p-6 flex items-center gap-6">
      {/* Progress Ring */}
      <div className="relative w-24 h-24">
        <svg
          viewBox="0 0 100 100"
          className="-rotate-90 w-full h-full"
        >
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
          <span className="text-xl font-bold text-foreground">
            {rate}%
          </span>
        </div>
      </div>
      <div className="flex flex-col gap-2">
        <h3 className="flex items-center gap-2 font-semibold text-foreground">
         نسبة الحضور
          <TrendingUp className="w-4 h-4 text-success" />
        </h3>

        <p className="text-sm text-muted-foreground">
         حضور المواعيد
        </p>
        <div className="flex gap-4 mt-1 text-sm">
          <div className="flex items-center gap-2">
           <span className="w-2.5 h-2.5 rounded-full bg-green-500" />
            <span className="text-foreground">
              {attended} <br/>حضر
            </span>
          </div>

          <div className="flex items-center gap-2">
            <span className="w-2.5 h-2.5 rounded-full bg-destructive" />
            <span className="text-foreground">
              {missed} <br/>لم يحضر
            </span>
          </div>
        </div>
      </div>
    </div>
  );
};
