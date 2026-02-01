import { NextResponse } from "next/server";
import { getCollection } from "@/lib/db";
import { eachDayOfInterval, startOfMonth, endOfMonth, format } from "date-fns";

export async function POST(req) {
  try {
    const { month, times } = await req.json();

    if (!month || !Array.isArray(times) || times.length === 0) {
      return NextResponse.json(
        { error: "Invalid payload" },
        { status: 400 }
      );
    }

    const collection = await getCollection("appointments");

    const start = startOfMonth(new Date(`${month}-01`));
    const end = endOfMonth(start);
    const days = eachDayOfInterval({ start, end });

    for (const day of days) {
      const dateKey = format(day, "yyyy-MM-dd");

      const existing = await collection.findOne(
        { date: dateKey },
        { projection: { "appointments.time": 1 } }
      );

      const appointmentTimes =
        existing?.appointments?.map((a) => a.time) || [];

  
      const safeTimesToBlock = times.filter(
        (t) => !appointmentTimes.includes(t)
      );


      await collection.updateOne(
        { date: dateKey },
        safeTimesToBlock.length
          ? {
              $addToSet: {
                blockedTimes: { $each: safeTimesToBlock },
              },
            }
          : {
              $setOnInsert: {
                date: dateKey,
                blockedTimes: [],
                appointments: [],
              },
            },
        { upsert: true }
      );
    }

    return NextResponse.json({ success: true });
  } catch (error) {
    console.error("Block month error:", error);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    );
  }
}
