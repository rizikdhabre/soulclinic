"use client";

import { useState } from "react";
import { motion } from "framer-motion";
import axios from "axios";
import { format } from "date-fns";
import { AnimatedCalendar } from "@/components/ui/AnimatedCalendar";
import { AppointmentHeader } from "@/components/ui/AppointmentHeader";
import { AppointmentForm } from "@/components/ui/AppointmentForm";
import { TimeSlotPicker } from "@/components/ui/TimeSlotPicker";
import { useSearchParams } from "next/navigation";
export default function AppointmentsPage() {
  const searchParams = useSearchParams();
  const duration = Number(searchParams.get("duration"));
  const price = Number(searchParams.get("price"));
  const title = searchParams.get("title");
  const treatmentId = searchParams.get("treatmentId");
  const cupsCount = searchParams.get("cupsCount");
  const [selectedDate, setSelectedDate] = useState(null);
  const [selectedTime, setSelectedTime] = useState(null);
  const [bookingError, setBookingError] = useState(null);

  const handleDateSelect = (date) => {
    setSelectedDate(date);
    setSelectedTime(null);
    setBookingError(null);
  };

  const handleTimeSelect = (time) => {
    setSelectedTime(time);
    setBookingError(null);
  };

  const handleFormSubmit = async (data) => {
    if (!selectedDate || !selectedTime) return;

    try {
      await axios.post("/api/appointments", {
        firstName: data.firstName,
        lastName: data.lastName,
        phone: data.phone,
        note: data.note,
        duration,
        price,
        title,
        date: format(selectedDate, "yyyy-MM-dd"),
        time: selectedTime,
         ...(cupsCount ? { cupsCount: Number(cupsCount) } : {}),
      });
    } catch (error) {
      if (error.response?.status === 409) {
        setBookingError(
          "This time slot was just booked. Please choose another time.",
        );
        setSelectedTime(null);
        return;
      }
      setBookingError("Something went wrong. Please try again.");
    }
  };

  return (
    <div className="min-h-screen gradient-hero">
      {/* Background decoration */}
      <div className="fixed inset-0 overflow-hidden pointer-events-none">
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ duration: 1 }}
          className="absolute top-0 right-0 w-[600px] h-[600px] rounded-full bg-primary/5 blur-3xl -translate-y-1/2 translate-x-1/2"
        />
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ duration: 1, delay: 0.2 }}
          className="absolute bottom-0 left-0 w-[600px] h-[600px] rounded-full bg-primary/5 blur-3xl translate-y-1/2 -translate-x-1/2"
        />
      </div>

      <div className="relative max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-12 md:py-20">
        <AppointmentHeader />

        <motion.div
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.6, delay: 0.5 }}
          className="grid grid-cols-1 lg:grid-cols-3 gap-6"
        >
          {/* Calendar Card */}
          <motion.div
            initial={{ opacity: 0, x: -20 }}
            animate={{ opacity: 1, x: 0 }}
            transition={{ duration: 0.5, delay: 0.6 }}
            className="bg-card rounded-2xl p-6 shadow-lg border border-border/50"
          >
            <AnimatedCalendar
              selectedDate={selectedDate}
              onSelectDate={handleDateSelect}
            />
          </motion.div>

          {/* Time Slots Card */}
          <motion.div
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.5, delay: 0.7 }}
            className="bg-card rounded-2xl p-6 shadow-lg border border-border/50"
          >
            <TimeSlotPicker
              selectedDate={selectedDate}
              selectedTime={selectedTime}
              onSelectTime={handleTimeSelect}
              duration={duration}
            />
          </motion.div>

          {/* Form Card */}
          <motion.div
            initial={{ opacity: 0, x: 20 }}
            animate={{ opacity: 1, x: 0 }}
            transition={{ duration: 0.5, delay: 0.8 }}
            className="bg-card rounded-2xl p-6 shadow-lg border border-border/50"
          >
            <AppointmentForm
              selectedDate={selectedDate}
              selectedTime={selectedTime}
              bookingError={bookingError}
              onSubmit={handleFormSubmit}
            />
          </motion.div>
        </motion.div>
      </div>
    </div>
  );
}
