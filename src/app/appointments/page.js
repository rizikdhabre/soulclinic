import { Suspense } from "react";
import AppointmentsClient from "./AppointmentsClient";
export const dynamic = "force-dynamic";

export default function AppointmentsPage() {
  return (
    <Suspense fallback={<div>Loading…</div>}>
      <AppointmentsClient />
    </Suspense>
  );
}
