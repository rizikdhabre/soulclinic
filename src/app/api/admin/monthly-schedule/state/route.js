import { getMonthlyScheduleState } from "@/lib/monthlySchedule";
import { monthlyScheduleRoute } from "@/lib/monthlyScheduleRoute";

export const GET = monthlyScheduleRoute(getMonthlyScheduleState, { readMonth: true });
