"use client";

import { useEffect, useState } from "react";
import axios from "axios";
import { format, isToday } from "date-fns";
import { motion } from "framer-motion";
import { Clock } from "lucide-react";
import { cn } from "@/lib/utils";

/* ---------------- helpers ---------------- */

const SLOT_MINUTES = 30;
const WORK_END = "19:30";

const timeToMinutes = (time) => {
  if (!time || typeof time !== "string") return null;

  const parts = time.split(":");
  if (parts.length !== 2) return null;

  const h = Number(parts[0]);
  const m = Number(parts[1]);

  if (Number.isNaN(h) || Number.isNaN(m)) return null;

  return h * 60 + m;
};

const getDurationMinutes = (value) => {
  const duration = Number(value);
  return Number.isFinite(duration) && duration > 0
    ? duration
    : SLOT_MINUTES;
};

const rangesOverlap = (startA, endA, startB, endB) => {
  return startA < endB && endA > startB;
};

const buildDefaultSlots = () => {
  const slots = [];

  for (let h = 10; h < 20; h++) {
    for (let m = 0; m < 60; m += SLOT_MINUTES) {
      const time = `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
      if (time <= WORK_END) slots.push(time);
    }
  }

  return slots;
};

const DEFAULT_SLOTS = buildDefaultSlots();

/* ---------------- component ---------------- */

export function TimeSlotPicker({
  selectedTime,
  onSelectTime,
  selectedDate,
  duration,
}) {
  const [bookedAppointments, setBookedAppointments] = useState([]);
  const [blockedTimes, setBlockedTimes] = useState([]);
  const [editedTimes, setEditedTimes] = useState([]);

  /* -------- fetch appointments for selected date -------- */

  useEffect(() => {
    if (!selectedDate) return;

    const fetchAppointments = async () => {
      try {
        const dateStr = format(selectedDate, "yyyy-MM-dd");

        const res = await axios.get("/api/appointments", {
          params: { date: dateStr },
        });

        const appts = Array.isArray(res.data?.appointments)
          ? res.data.appointments
          : [];

        const blocked = Array.isArray(res.data?.blockedTimes)
          ? res.data.blockedTimes
          : [];

        const editedTimes = Array.isArray(res.data?.editedTimes)
          ? res.data.editedTimes
          : [];

        setEditedTimes(editedTimes);

        setBookedAppointments(appts);
        setBlockedTimes(blocked);
      } catch (error) {
        console.error("Failed to fetch appointments:", error);
        setBookedAppointments([]);
        setBlockedTimes([]);
      }
    };

    fetchAppointments();
  }, [selectedDate]);
  if (!selectedDate) {
    return (
      <div className="text-center py-12 text-muted-foreground">
        <Clock className="mx-auto mb-4 w-6 h-6" />
      يرجى اختيار تاريخ أولًا
      </div>
    );
  }

  const generateSlots = () => {
    const now = new Date();
    const serviceDuration = getDurationMinutes(duration);
    const sourceTimes = editedTimes.length > 0 ? editedTimes : DEFAULT_SLOTS;
    const workEnd = timeToMinutes(WORK_END);

    return sourceTimes.map((time) => {
      let available = true;

      const startMinutes = timeToMinutes(time);
      if (startMinutes === null) return { time, available: false };

      const endMinutes = startMinutes + serviceDuration;

      if (blockedTimes.includes(time)) {
        available = false;
      }

      if (isToday(selectedDate)) {
        const [h, m] = time.split(":").map(Number);
        const slotDate = new Date(selectedDate);
        slotDate.setHours(h, m, 0, 0);
        if (slotDate < now) available = false;
      }

      if (endMinutes > workEnd) {
        available = false;
      }

      for (const booking of bookedAppointments) {
        if (!booking?.time) continue;

        const bookingStart = timeToMinutes(booking.time);
        if (bookingStart === null) continue;

        const bookingDuration = getDurationMinutes(booking.duration);
        const bookingEnd = bookingStart + bookingDuration;

        if (rangesOverlap(startMinutes, endMinutes, bookingStart, bookingEnd)) {
          available = false;
          break;
        }
      }

      return { time, available };
    });
  };

  const slots = generateSlots();

  return (
    <div>
      <h3 className="mb-4 flex items-center gap-2 font-medium">
        <Clock className="w-5 h-5" />
        الأوقات المتاحة
      </h3>

      <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
        {slots.map((slot) => (
          <motion.button
            key={slot.time}
            whileHover={slot.available ? { scale: 1.05 } : undefined}
            whileTap={slot.available ? { scale: 0.97 } : undefined}
            onClick={() => slot.available && onSelectTime(slot.time)}
            disabled={!slot.available}
            className={cn(
              "px-4 py-3 rounded-xl text-sm font-medium transition",
              slot.available
                ? "bg-secondary hover:bg-secondary/80"
                : "bg-muted text-muted-foreground line-through cursor-not-allowed",
              selectedTime === slot.time &&
                "bg-primary text-white hover:bg-primary",
            )}
          >
            {slot.time}
          </motion.button>
        ))}
      </div>
    </div>
  );
}
