import { Suspense } from "react";
import UserAppointmentsClient from "./UserAppointmentsClient";


export default function UserAppointmentsPage() {
  return (
    <Suspense fallback={<div>Loading appointments...</div>}>
      <UserAppointmentsClient />
    </Suspense>
  );
}