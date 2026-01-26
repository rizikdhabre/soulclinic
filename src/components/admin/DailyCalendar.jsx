"use client";

import { useEffect, useMemo, useState } from "react";
import axios from "axios";
import {
  ChevronLeft,
  ChevronRight,
  Clock,
  User,
  Stethoscope,
  CalendarX,
  Lock,
  Unlock,
} from "lucide-react";
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
} from "date-fns";

/* ---------- helpers ---------- */

const SLOT_MINUTES = 30;

const buildSlots = (
  startHour = 10,
  endHour = 20,
  stepMinutes = SLOT_MINUTES,
) => {
  const slots = [];
  for (let h = startHour; h < endHour; h++) {
    for (let m = 0; m < 60; m += stepMinutes) {
      slots.push(`${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`);
    }
  }
  return slots;
};

const ALL_SLOTS = buildSlots();

const toMinutes = (t) => {
  const [h, m] = String(t || "")
    .split(":")
    .map(Number);
  if (Number.isNaN(h) || Number.isNaN(m)) return 0;
  return h * 60 + m;
};

/* ---------- component ---------- */

const DailyCalendar = () => {
  const [currentMonth, setCurrentMonth] = useState(new Date());
  const [selectedDate, setSelectedDate] = useState(new Date());
  const [appointments, setAppointments] = useState([]);
  const [blockedTimes, setBlockedTimes] = useState([]);
  const [editedTimes, setEditedTimes] = useState([]);
  const [loadingDay, setLoadingDay] = useState(false);
  const [editMode, setEditMode] = useState(false);
  const [editingAppointmentId, setEditingAppointmentId] = useState(null);
  const [editingAppointmentTime, setEditingAppointmentTime] = useState("");
  const [draftEditedTimes, setDraftEditedTimes] = useState([]);
  const [baseEditedTimes, setBaseEditedTimes] = useState([]);
  const [draftTimeByIndex, setDraftTimeByIndex] = useState({});
  const selectedDateKey = format(selectedDate, "yyyy-MM-dd");

  /* ---------- calendar ---------- */

  const monthStart = startOfMonth(currentMonth);
  const monthEnd = endOfMonth(currentMonth);
  const calendarStart = startOfWeek(monthStart);
  const calendarEnd = endOfWeek(monthEnd);
  const days = eachDayOfInterval({ start: calendarStart, end: calendarEnd });
  const weekDays = [
    "الأحد",
    "الاثنين",
    "الثلاثاء",
    "الأربعاء",
    "الخميس",
    "الجمعة",
    "السبت",
  ];

  /* ---------- fetch ---------- */

  const fetchDay = async () => {
    try {
      setLoadingDay(true);
      const res = await axios.get("/api/appointments", {
        params: { date: selectedDateKey, admin: true },
      });

      setAppointments(res.data?.appointments || []);
      setBlockedTimes(res.data?.blockedTimes || []);
      setEditedTimes(res.data?.editedTimes || []);
    } catch (err) {
      console.error("Failed to fetch day data", err);
      setAppointments([]);
      setBlockedTimes([]);
      setEditedTimes([]);
    } finally {
      setLoadingDay(false);
    }
  };

  useEffect(() => {
    fetchDay();
  }, [selectedDateKey]);

  useEffect(() => {
    setEditingAppointmentId(null);
    setEditingAppointmentTime("");
  }, [selectedDateKey]);

  useEffect(() => {
    if (!editMode) {
      setDraftTimeByIndex({});
    }
  }, [editMode]);

  /* ---------- SLOT MODEL ---------- */

  const sourceTimes = editMode
    ? draftEditedTimes.length
      ? draftEditedTimes
      : editedTimes.length
        ? editedTimes
        : ALL_SLOTS
    : editedTimes.length
      ? editedTimes
      : ALL_SLOTS;

  const normalizedBlockedTimes = useMemo(
    () => blockedTimes.filter((t) => sourceTimes.includes(t)),
    [blockedTimes, sourceTimes],
  );

  const timeline = useMemo(() => {
    const rows = [];

    // 1️⃣ Always render appointments at their actual time
    appointments.forEach((apt) => {
      rows.push({
        time: apt.time,
        apt,
        blocked: false,
      });
    });

    // 2️⃣ Render slots ONLY if no appointment overlaps them
    sourceTimes.forEach((time) => {
      const slotStart = toMinutes(time);
      const slotEnd = slotStart + SLOT_MINUTES;

      const overlaps = appointments.some((apt) => {
        const aptStart = toMinutes(apt.time);
        const aptEnd = aptStart + apt.duration;
        return aptStart < slotEnd && aptEnd > slotStart;
      });

      if (!overlaps) {
        rows.push({
          time,
          apt: null,
          blocked: blockedTimes.includes(time),
        });
      }
    });

    // 3️⃣ Sort everything by time
    return editMode
      ? rows
      : rows.sort((a, b) => toMinutes(a.time) - toMinutes(b.time));
  }, [appointments, sourceTimes, blockedTimes]);

  /* ---------- actions ---------- */

  const toggleBlock = async (time) => {
    const isBlocked = blockedTimes.includes(time);

    try {
      await axios.post("/api/appointments/block", {
        date: selectedDateKey,
        time,
        block: !isBlocked,
      });

      setBlockedTimes((prev) =>
        isBlocked ? prev.filter((t) => t !== time) : [...prev, time],
      );
    } catch (err) {
      console.error("Failed to toggle block", err);
    }
  };

  const handleBlockAll = async () => {
    try {
      await axios.post("/api/appointments/blockAll", {
        date: selectedDateKey,
      });

      setBlockedTimes(sourceTimes);
    } catch (err) {
      console.error("Failed to block all times", err);
    }
  };

  const handleToggleEdit = () => {
    setEditMode((prev) => {
      const next = !prev;

      if (next) {
        const base = editedTimes.length > 0 ? editedTimes : ALL_SLOTS;
        setBaseEditedTimes([...base]);
        setDraftEditedTimes([...base]);
      } else {
        setBaseEditedTimes([]);
        setDraftEditedTimes([]);
      }

      return next;
    });
  };

  const getStatusBadgeClass = (status) => {
    switch (status) {
      case "scheduled":
        return "badge-status badge-scheduled";
      case "attended":
        return "badge-status badge-attended";
      case "canceled":
        return "badge-status badge-canceled";
      default:
        return "badge-status";
    }
  };

  /* ---------- render ---------- */

  return (
    <div className="card-elevated p-6">
      <div className="flex items-center justify-between mb-6">
        <h3 className="text-xl font-display font-semibold text-foreground">
          المواعيد اليومية
        </h3>
        <div className="flex items-center gap-2">
          <button
            onClick={() => setCurrentMonth(subMonths(currentMonth, 1))}
            className="p-2 rounded-xl hover:bg-muted transition-colors"
          >
            <ChevronRight className="w-5 h-5 text-muted-foreground" />
          </button>
          <span className="text-base font-semibold min-w-[140px] text-center">
            {format(currentMonth, "MMMM yyyy")}
          </span>
          <button
            onClick={() => setCurrentMonth(addMonths(currentMonth, 1))}
            className="p-2 rounded-xl hover:bg-muted transition-colors"
          >
            <ChevronLeft className="w-5 h-5 text-muted-foreground" />
          </button>
        </div>
      </div>

      <div className="grid grid-cols-7 gap-1 mb-2">
        {weekDays.map((day) => (
          <div
            key={day}
            className="text-center text-xs font-medium text-muted-foreground py-2"
          >
            {day}
          </div>
        ))}
      </div>

      <div className="grid grid-cols-7 gap-1 mb-6">
        {days.map((day) => {
          const isCurrent = isSameMonth(day, currentMonth);
          const isSelected = isSameDay(day, selectedDate);

          return (
            <button
              key={day.toISOString()}
              onClick={() => setSelectedDate(day)}
              className={`calendar-day ${
                !isCurrent ? "text-muted-foreground/40" : ""
              } ${isSelected ? "calendar-day-selected" : ""}`}
            >
              {format(day, "d")}
            </button>
          );
        })}
      </div>

      <div className="border-t border-border pt-6">
        <h4 className="text-base font-semibold text-foreground mb-4">
          جدول المواعيد بتاريخ {format(selectedDate, "MMMM d, yyyy")}
        </h4>

        <div className="mt-6 mb-4 flex items-center justify-between">
          <h4 className="text-sm font-medium text-muted-foreground">
            {format(selectedDate, "MMMM d, yyyy")}
          </h4>

          <div className="flex gap-2">
            <button
              onClick={handleToggleEdit}
              className={`px-4 py-2 rounded-xl text-sm font-medium transition ${
                editMode
                  ? "bg-primary text-primary-foreground"
                  : "bg-secondary hover:bg-secondary/80"
              }`}
            >
              {editMode ? "الخروج من التعديل" : "تعديل الأوقات"}
            </button>

            {editMode && (
              <button
                onClick={async () => {
                  const next = baseEditedTimes.map(
                    (t) => draftTimeByIndex[t] ?? t,
                  );

                  const nextBlocked = Array.from(
                    new Set(blockedTimes.map((t) => draftTimeByIndex[t] ?? t)),
                  );

                  await axios.post("/api/appointments/edit", {
                    date: selectedDateKey,
                    editedTimes: next,
                    blockedTimes: nextBlocked,
                  });

                  setEditedTimes(next);
                  setBlockedTimes(nextBlocked);
                  setDraftTimeByIndex({});
                  setBaseEditedTimes([]);
                  setDraftEditedTimes([]);
                  setEditMode(false);
                  fetchDay();
                }}
                className="px-4 py-2 rounded-xl text-sm font-medium bg-primary text-primary-foreground"
              >
                حفظ التغييرات
              </button>
            )}

            <button
              onClick={handleBlockAll}
              className="px-4 py-2 rounded-xl text-sm font-medium bg-destructive/10 text-destructive hover:bg-destructive/20 transition"
            >
              حظر الكل
            </button>
          </div>
        </div>

        {loadingDay ? (
          <div className="py-10 text-center text-muted-foreground">
            Loading…
          </div>
        ) : timeline.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-12 text-muted-foreground">
            <CalendarX className="w-12 h-12 mb-3 opacity-50" />
            <p className="text-sm">No data</p>
          </div>
        ) : (
          <div className="space-y-2">
            {timeline.map((row) => {
              const apt = row.apt;

              if (apt) {
                return (
                  <div
                    key={apt._id || row.time}
                    className="flex items-center gap-4 p-4 rounded-xl bg-muted/50 hover:bg-muted transition-colors"
                  >
                    <div className="flex items-center gap-2 min-w-[80px]">
                      <Clock className="w-4 h-4 text-primary" />
                      {editingAppointmentId === apt._id ? (
                        <input
                          type="time"
                          value={editingAppointmentTime}
                          onClick={(e) => e.stopPropagation()}
                          onMouseDown={(e) => e.stopPropagation()}
                          onChange={(e) =>
                            setEditingAppointmentTime(e.target.value)
                          }
                          className="
                            border rounded px-2 py-1 text-sm
                            bg-background
                            text-foreground
                            dark:bg-muted
                            dark:text-foreground
                            focus:outline-none focus:ring-2 focus:ring-primary
                          "
                        />
                      ) : (
                        <span className="font-semibold text-sm">
                          {apt.time}
                        </span>
                      )}
                    </div>

                    <div className="flex items-center gap-2 flex-1 min-w-0">
                      <User className="w-4 h-4 text-muted-foreground shrink-0" />
                      <span className="text-sm truncate">
                        {apt.firstName} {apt.lastName}
                      </span>
                    </div>

                    <div className="flex items-center gap-2 flex-1 min-w-0">
                      <Stethoscope className="w-4 h-4 text-muted-foreground shrink-0" />
                      <span className="text-sm truncate">{apt.title}</span>
                    </div>

                    <span className="text-xs text-muted-foreground bg-secondary px-2 py-1 rounded-lg shrink-0">
                      {apt.duration} min
                    </span>

                    {editingAppointmentId === apt._id ? (
                      <button
                        onClick={async () => {
                          try {
                            await axios.post("/api/appointments/update-time", {
                              appointmentId: apt._id,
                              date: selectedDateKey,
                              newTime: editingAppointmentTime,
                            });

                            setEditingAppointmentId(null);
                            setEditingAppointmentTime("");
                            fetchDay();
                          } catch (err) {
                            console.error(
                              "Failed to update appointment time",
                              err,
                            );
                          }
                        }}
                        className="px-3 py-1 text-xs rounded bg-primary text-primary-foreground"
                      >
                        Save
                      </button>
                    ) : (
                      <button
                        onClick={() => {
                          setEditingAppointmentId(apt._id);
                          setEditingAppointmentTime(apt.time);
                        }}
                        className="px-3 py-1 text-xs rounded bg-secondary"
                      >
                        Edit
                      </button>
                    )}

                    {apt.status ? (
                      <span className={getStatusBadgeClass(apt.status)}>
                        {String(apt.status).charAt(0).toUpperCase() +
                          String(apt.status).slice(1)}
                      </span>
                    ) : null}
                  </div>
                );
              }

              return (
                <div
                  key={`slot-${row.time}`}
                  className="flex items-center gap-4 p-4 rounded-xl bg-muted/30"
                >
                  <div className="flex items-center gap-2 min-w-[80px]">
                    <Clock className="w-4 h-4 text-primary" />
                    {editMode ? (
                      <input
                        type="time"
                        onClick={(e) => e.stopPropagation()}
                        onMouseDown={(e) => e.stopPropagation()}
                        value={draftTimeByIndex[row.time] ?? row.time}
                        onChange={(e) => {
                          const value = e.target.value;
                          setDraftTimeByIndex((prev) => ({
                            ...prev,
                            [row.time]: value,
                          }));
                        }}
                        className="
                            border rounded px-2 py-1 text-sm
                            bg-background
                            text-foreground
                            dark:bg-muted
                            dark:text-foreground
                            focus:outline-none focus:ring-2 focus:ring-primary
                          "
                      />
                    ) : (
                      <span className="font-semibold text-sm">{row.time}</span>
                    )}
                  </div>

                  <div className="flex-1 min-w-0 text-sm text-muted-foreground">
                    {row.blocked ? "محظور" : "متاح"}
                  </div>

                  <button
                    onClick={() => toggleBlock(row.time)}
                    disabled={editMode}
                    className={`flex items-center gap-2 text-xs font-medium px-3 py-2 rounded-lg transition ${
                      editMode
                        ? "opacity-40 cursor-not-allowed"
                        : row.blocked
                          ? "bg-muted text-muted-foreground hover:bg-muted/70"
                          : "bg-primary/10 text-primary hover:bg-primary/20"
                    }`}
                  >
                    {row.blocked ? (
                      <>
                        <Unlock className="w-4 h-4" />
                        إلغاء الحظر
                      </>
                    ) : (
                      <>
                        <Lock className="w-4 h-4" />
                        حظر
                      </>
                    )}
                  </button>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
};

export default DailyCalendar;
