import { Suspense } from "react";
import AppointmentsClient from "./AppointmentsClient";

export default function AppointmentsPage() {
  return (
    <Suspense fallback={<div>Loading…</div>}>
      <AppointmentsClient />
    </Suspense>
  );
}
