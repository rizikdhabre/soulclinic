"use client";

import { useEffect, useState } from "react";
import axios from "axios";
import { format, isToday } from "date-fns";
import { motion } from "framer-motion";
import { Clock } from "lucide-react";
import { cn } from "@/lib/utils";

/* ---------------- helpers ---------------- */

const timeToMinutes = (time) => {
  if (!time || typeof time !== "string") return null;

  const parts = time.split(":");
  if (parts.length !== 2) return null;

  const h = Number(parts[0]);
  const m = Number(parts[1]);

  if (Number.isNaN(h) || Number.isNaN(m)) return null;

  return h * 60 + m;
};

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

  const generateTimeSlots = () => {
    const slots = [];
    const now = new Date();
    const serviceDuration = Number(duration) || 30;

    for (let h = 10; h < 20; h++) {
      for (let m = 0; m < 60; m += 30) {
        const startTime = `${String(h).padStart(2, "0")}:${String(m).padStart(
          2,
          "0",
        )}`;
        if (blockedTimes.includes(startTime)) {
          slots.push({ time: startTime, available: false });
          continue;
        }

        const startMinutes = timeToMinutes(startTime);
        if (startMinutes === null) continue;

        const endMinutes = startMinutes + serviceDuration;

        let available = true;

        if (isToday(selectedDate)) {
          const slotDate = new Date(selectedDate);
          slotDate.setHours(h, m, 0, 0);
          if (slotDate < now) available = false;
        }
        if (endMinutes > 21.5 * 60) {
          available = false;
        }
        const SLOT_SIZE = 30;

        const slotStart = startMinutes;
        const slotEnd = startMinutes + SLOT_SIZE;
        for (const booking of bookedAppointments) {
          if (!booking?.time) continue;

          const bookingStart = timeToMinutes(booking.time);
          if (bookingStart === null) continue;

          const realDuration = Number(booking.duration) || 30;

          const roundedDuration =
            Math.ceil(realDuration / SLOT_SIZE) * SLOT_SIZE;

          const bookingEnd = bookingStart + roundedDuration;

          if (slotStart < bookingEnd && bookingStart < slotEnd) {
            available = false;
            break;
          }
        }
        slots.push({ time: startTime, available });
      }
    }

    return slots;
  };

  const generateSlotsFromEditedTimes = () => {
    const slots = [];
    const now = new Date();
    const serviceDuration = Number(duration) || 30;
    const SLOT_SIZE = 30;

    for (const time of editedTimes) {
      let available = true;

      // blocked manually by admin
      if (blockedTimes.includes(time)) {
        slots.push({ time, available: false });
        continue;
      }

      const startMinutes = timeToMinutes(time);
      if (startMinutes === null) {
        slots.push({ time, available: false });
        continue;
      }

      const endMinutes = startMinutes + serviceDuration;

      // past time
      if (isToday(selectedDate)) {
        const [h, m] = time.split(":").map(Number);
        const slotDate = new Date(selectedDate);
        slotDate.setHours(h, m, 0, 0);
        if (slotDate < now) available = false;
      }

      // outside working hours
      if (endMinutes > 21.5 * 60) {
        available = false;
      }

      // overlap with existing appointments
      for (const booking of bookedAppointments) {
        if (!booking?.time) continue;

        const bookingStart = timeToMinutes(booking.time);
        if (bookingStart === null) continue;

        const realDuration = Number(booking.duration) || 30;
        const roundedDuration = Math.ceil(realDuration / SLOT_SIZE) * SLOT_SIZE;

        const bookingEnd = bookingStart + roundedDuration;

        if (
          startMinutes < bookingEnd &&
          bookingStart < startMinutes + SLOT_SIZE
        ) {
          available = false;
          break;
        }
      }

      slots.push({ time, available });
    }

    return slots;
  };

  const slots =
    editedTimes.length > 0
      ? generateSlotsFromEditedTimes()
      : generateTimeSlots();

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
