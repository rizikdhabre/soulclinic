"use client";

import { useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { ChevronLeft, ChevronRight } from "lucide-react";
import {
  format,
  startOfMonth,
  endOfMonth,
  eachDayOfInterval,
  isSameMonth,
  isSameDay,
  addMonths,
  subMonths,
  startOfWeek,
  endOfWeek,
  isToday,
  isBefore,
} from "date-fns";
import { cn } from "@/lib/utils";
import { formatCuppingLegend, getCuppingMonth } from "@/lib/hijriCuppingDates";
import styles from "./HijriCupping.module.css";

const WEEKDAYS = ["الأحد", "الاثنين", "الثلاثاء", "الأربعاء", "الخميس", "الجمعة", "السبت"];
export function AnimatedCalendar({
  selectedDate,
  onSelectDate,
  availableDates = [],
}) {
  const [currentMonth, setCurrentMonth] = useState(new Date());
  const [direction, setDirection] = useState(0);

  const monthStart = startOfMonth(currentMonth);
  const monthEnd = endOfMonth(currentMonth);
  const calendarStart = startOfWeek(monthStart);
  const calendarEnd = endOfWeek(monthEnd);
  const cuppingDates = getCuppingMonth(currentMonth.getFullYear(), currentMonth.getMonth());
  const cuppingByDate = new Map(cuppingDates.map(date => [date.date, date]));

  const days = eachDayOfInterval({
    start: calendarStart,
    end: calendarEnd,
  });

  const goToPreviousMonth = () => {
    setDirection(-1);
    setCurrentMonth(subMonths(currentMonth, 1));
  };

  const goToNextMonth = () => {
    setDirection(1);
    setCurrentMonth(addMonths(currentMonth, 1));
  };

  const isDateAvailable = (date) => {
    if (!availableDates.length) return true;
    return availableDates.some((d) => isSameDay(d, date));
  };

  const isPastDate = (date) => {
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    return isBefore(date, today);
  };

  const slideVariants = {
    enter: (direction) => ({
      x: direction > 0 ? 100 : -100,
      opacity: 0,
    }),
    center: { x: 0, opacity: 1 },
    exit: (direction) => ({
      x: direction < 0 ? 100 : -100,
      opacity: 0,
    }),
  };

  return (
    <div className={`w-full ${styles.scope}`}>
      {/* Header */}
      <div className="flex items-center justify-between mb-6">
        <motion.button
          type="button"
          aria-label="الشهر السابق"
          whileHover={{ scale: 1.1 }}
          whileTap={{ scale: 0.95 }}
          onClick={goToPreviousMonth}
          className="p-2 rounded-xl bg-secondary"
        >
          <ChevronRight className="w-5 h-5" />
        
        </motion.button>

        <AnimatePresence mode="wait" custom={direction}>
          <motion.h2
            key={format(currentMonth, "MMMM yyyy")}
            custom={direction}
            variants={slideVariants}
            initial="enter"
            animate="center"
            exit="exit"
            transition={{ duration: 0.3, ease: "easeInOut" }}
            className="text-xl font-semibold"
          >
            {format(currentMonth, "MMMM yyyy")}
          </motion.h2>
        </AnimatePresence>

        <motion.button
          type="button"
          aria-label="الشهر التالي"
          whileHover={{ scale: 1.1 }}
          whileTap={{ scale: 0.95 }}
          onClick={goToNextMonth}
          className="p-2 rounded-xl bg-secondary"
        >
          <ChevronLeft className="w-5 h-5" />
        </motion.button>
      </div>

      {/* Weekdays */}
      <div className="grid grid-cols-7 gap-1 mb-2">
        {WEEKDAYS.map((day) => (
          <div
            key={day}
            className="text-center text-xs font-medium text-muted-foreground p-"
          >
            {day}
          </div>
        ))}
      </div>

      {/* Calendar Grid */}
      <AnimatePresence mode="wait" custom={direction}>
        <motion.div
          key={format(currentMonth, "MMMM yyyy")}
          custom={direction}
          variants={slideVariants}
          initial="enter"
          animate="center"
          exit="exit"
          transition={{ duration: 0.3, ease: "easeInOut" }}
          className="grid grid-cols-7 gap-1"
        >
          {days.map((day, index) => {
            const isCurrentMonth = isSameMonth(day, currentMonth);
            const isSelected =
              selectedDate && isSameDay(day, selectedDate);
            const isTodayDate = isToday(day);
            const isAvailable =
              isDateAvailable(day) && !isPastDate(day);
            const cuppingDate = isCurrentMonth ? cuppingByDate.get(format(day, "yyyy-MM-dd")) : null;

            return (
              <motion.button
                type="button"
                key={day.toISOString()}
                aria-pressed={Boolean(isSelected)}
                aria-label={`${format(day, "dd/MM/yyyy")}${cuppingDate ? `، ${cuppingDate.hijriLabel}، من أيام الحجامة` : ""}`}
                data-hijri-cupping={Boolean(cuppingDate)}
                initial={{ opacity: 0, scale: 0.85 }}
                animate={{ opacity: 1, scale: 1 }}
                transition={{ delay: index * 0.01 }}
                disabled={!isCurrentMonth || !isAvailable}
                onClick={() =>
                  isCurrentMonth && isAvailable && onSelectDate(day)
                }
                className={cn(
                  "relative aspect-square flex items-center justify-center rounded-xl text-sm font-medium transition-all",
                  cuppingDate && isAvailable && !isSelected && styles.markedDay,
                  isSelected && "bg-primary text-primary-foreground shadow-lg",
                  isTodayDate &&
                    !isSelected &&
                    "ring-2 ring-primary/50",
                  !isCurrentMonth && "text-muted-foreground/30",
                  !isAvailable &&
                    "cursor-not-allowed text-muted-foreground/50"
                )}
              >
                {cuppingDate && <span aria-hidden="true" data-hijri-ring className={cn(styles.calendarCircle, isSelected && styles.selectedCircle, !isAvailable && styles.disabledCircle)} />}
                {format(day, "d")}
              </motion.button>
            );
          })}
        </motion.div>
      </AnimatePresence>
      <p className={styles.legend} aria-live="polite">
        <span className={styles.legendRing} aria-hidden="true" />
        <span>ايام الحجامة الهجرية : <bdi dir="ltr">{formatCuppingLegend(cuppingDates)}</bdi></span>
      </p>
    </div>
  );
}
