import { applyMonthlySchedule } from "@/lib/monthlySchedule";
import { monthlyScheduleRoute } from "@/lib/monthlyScheduleRoute";

export const POST = monthlyScheduleRoute(applyMonthlySchedule);
