"use client";

import { motion } from "framer-motion";
export function AppointmentHeader() {
  return (
    <motion.div
      initial={{ opacity: 0, y: -20 }}
      animate={{ opacity: 1, y: 0 }}
      className="text-center mb-10 mt-20"
    >

      <h1 className="text-4xl font-bold mb-2">
      حجز موعد
      </h1>

      <p className="text-muted-foreground">
        اختر التاريخ والوقت المناسبين لك.
      </p>
    </motion.div>
  );
}
