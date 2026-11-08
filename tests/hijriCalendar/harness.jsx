import React, { StrictMode, useState } from "react";
import { createRoot } from "react-dom/client";
import HijriCuppingTable from "@/components/ui/HijriCuppingTable";
import { AnimatedCalendar } from "@/components/ui/AnimatedCalendar";

function Harness() {
  const [selectedDate, setSelectedDate] = useState(null);
  const [restricted, setRestricted] = useState(false);
  return (
    <main className="mx-auto max-w-4xl px-3 py-8" dir="rtl">
      <section data-testid="home-dates"><HijriCuppingTable /></section>
      <section data-testid="booking-calendar" className="mx-auto mt-12 max-w-xl">
        <AnimatedCalendar selectedDate={selectedDate} onSelectDate={setSelectedDate}
          availableDates={restricted ? [new Date(2026, 10, 29)] : []} />
      </section>
      <button type="button" data-testid="restrict" onClick={() => setRestricted(value => !value)}>Toggle test availability</button>
      <output data-testid="selected" hidden>{selectedDate ? `${selectedDate.getFullYear()}-${selectedDate.getMonth() + 1}-${selectedDate.getDate()}` : ""}</output>
    </main>
  );
}

createRoot(document.getElementById("root")).render(<StrictMode><Harness /></StrictMode>);
