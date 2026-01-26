import { NextResponse } from "next/server";
import { getCollection } from "@/lib/db";

const buildDefaultSlots = () => {
  const slots = [];
  for (let h = 10; h < 20; h++) {
    for (let m = 0; m < 60; m += 30) {
      slots.push(`${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`);
    }
  }
  return slots;
};

export async function POST(req) {
  try {
    const { date } = await req.json();

    if (!date) {
      return NextResponse.json(
        { message: "Missing date" },
        { status: 400 },
      );
    }

    const collection = await getCollection("appointments");

    const day = await collection.findOne({ date });


    const slotTimes =
      Array.isArray(day?.editedTimes) && day.editedTimes.length > 0
        ? day.editedTimes
        : buildDefaultSlots();

    const appointmentTimes = Array.isArray(day?.appointments)
      ? day.appointments.map((a) => a.time)
      : [];

    const blockedTimes = slotTimes.filter(
      (t) => !appointmentTimes.includes(t),
    );

    await collection.updateOne(
      { date },
      { $set: { blockedTimes } },
      { upsert: true },
    );

    return NextResponse.json({ success: true });
  } catch (error) {
    console.error("Block ALL error:", error);
    return NextResponse.json(
      { message: "Internal server error" },
      { status: 500 },
    );
  }
}
