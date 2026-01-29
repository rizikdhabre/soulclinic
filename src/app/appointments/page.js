import { Suspense } from "react";
import AppointmentsClient from "./AppointmentsClient";
import NeonLoader from "@/components/ui/loading";

export default function AppointmentsPage() {
  return (
    <Suspense
      fallback={
        <div className="min-h-screen flex flex-col items-center justify-center gap-6">
          <NeonLoader width={320} height={80} />
          <p className="text-muted-foreground text-lg animate-pulse">
            جاري التحميل...
          </p>
        </div>
      }
    >
      <AppointmentsClient />
    </Suspense>
  );
}
