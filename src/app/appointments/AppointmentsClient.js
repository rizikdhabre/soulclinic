"use client";
import { useLayoutEffect, useRef, useState } from "react";
import { useReducedMotion } from "framer-motion";
import axios from "axios";
import { format } from "date-fns";
import { AnimatedCalendar } from "@/components/ui/AnimatedCalendar";
import { AppointmentHeader } from "@/components/ui/AppointmentHeader";
import { AppointmentForm } from "@/components/ui/AppointmentForm";
import { TimeSlotPicker } from "@/components/ui/TimeSlotPicker";
import { useSearchParams } from "next/navigation";
import { scrollBookingStep } from "./scrollBookingStep";

export default function AppointmentsClient() {
  const searchParams = useSearchParams();
  const duration = Number(searchParams.get("duration"));
  const price = Number(searchParams.get("price"));
  const title = searchParams.get("title");
  const cupsCount = searchParams.get("cupsCount");
  const [selectedDate, setSelectedDate] = useState(null);
  const [selectedTime, setSelectedTime] = useState(null);
  const [bookingError, setBookingError] = useState(null);
  const [availabilityRefreshKey, setAvailabilityRefreshKey] = useState(0);
  const [isBookingBusy, setBookingBusy] = useState(false);
  const timesRef = useRef(null);
  const formRef = useRef(null);
  const reduceMotion = useReducedMotion();

  useLayoutEffect(() => {
    if (!selectedDate) return;
    const target = selectedTime ? formRef.current : timesRef.current;
    return scrollBookingStep(target, reduceMotion);
  }, [selectedDate, selectedTime, reduceMotion]);

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
    if (!selectedDate || !selectedTime) {
      return false;
    }

    try {
      await axios.post("/api/appointments", {
        firstName: data.firstName,
        lastName: data.lastName,
        phone: data.phone,
        note: data.note,
        verificationToken: data.verificationToken,
        duration,
        price,
        title,
        date: format(selectedDate, "yyyy-MM-dd"),
        time: selectedTime,
         ...(cupsCount ? { cupsCount: Number(cupsCount) } : {}),
      });

      return true;
    } catch (error) {
      if (
        error.response?.status === 409 &&
        error.response?.data?.error === "TIME_SLOT_UNAVAILABLE"
      ) {
        setBookingError("هذه الساعة تم حجزها للتو، الرجاء اختيار ساعة أخرى.");
        setSelectedTime(null);
        setAvailabilityRefreshKey((key) => key + 1);
        return false;
      }

      if (
        error.response?.data?.error?.startsWith("OTP_VERIFICATION_") ||
        error.response?.data?.error === "INVALID_PHONE"
      ) {
        setBookingError("انتهت صلاحية التحقق. يرجى طلب رمز تحقق جديد.");
        return false;
      }

      setBookingError("Something went wrong. Please try again.");
      return false;
    }
  };

  return (
    <div className="min-h-screen bg-background" dir="rtl" style={{ overflowAnchor: "none" }}>
      <div className="max-w-xl mx-auto px-4 sm:px-6 py-12 md:py-20">
        <AppointmentHeader />

        <div className="space-y-8">
          <fieldset role="region" aria-label="اختيار التاريخ" disabled={isBookingBusy} className="min-w-0 overflow-hidden pb-4">
            <AnimatedCalendar
              selectedDate={selectedDate}
              onSelectDate={handleDateSelect}
            />
          </fieldset>

          <fieldset
            role="region"
            ref={timesRef}
            aria-label="اختيار الوقت"
            disabled={isBookingBusy}
            hidden={!selectedDate}
            className="min-w-0 scroll-mt-40 min-h-[calc(100svh-10rem)] border-t border-border pt-6"
          >
            {bookingError && !selectedTime && (
              <p role="alert" className="mb-4 rounded-lg bg-red-500/10 px-4 py-3 text-sm text-red-600">{bookingError}</p>
            )}
            <TimeSlotPicker
              selectedDate={selectedDate}
              selectedTime={selectedTime}
              onSelectTime={handleTimeSelect}
              duration={duration}
              refreshKey={availabilityRefreshKey}
            />
          </fieldset>

          <section
            ref={formRef}
            aria-label="تأكيد الموعد"
            hidden={!selectedTime}
            className="scroll-mt-40 min-h-[calc(100svh-10rem)] border-t border-border pt-6"
          >
            {/* Keep the form and its reCAPTCHA root mounted when selection changes. */}
            <AppointmentForm
              selectedDate={selectedDate}
              selectedTime={selectedTime}
              bookingError={bookingError}
              onBookingBusyChange={setBookingBusy}
              onSubmit={handleFormSubmit}
            />
          </section>
        </div>
      </div>
    </div>
  );
}
