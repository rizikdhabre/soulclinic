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
        Book an Appointment
      </h1>

      <p className="text-muted-foreground">
        Select a date and time that works best for you.
      </p>
    </motion.div>
  );
}
