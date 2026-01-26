import { getCollection } from "@/lib/db";
import { NextResponse } from "next/server";


export async function POST(req) {
  try {
    const body = await req.json();
    const { date, editedTimes } = body;
    if (!date || !Array.isArray(editedTimes)) {
      return NextResponse.json(
        { error: "Invalid payload: date and editedTimes are required" },
        { status: 400 },
      );
    }

    const collection = await getCollection("appointments");
    await collection.updateOne(
      { date },
      {
        $set: { editedTimes },
      },
      { upsert: true },
    );

    return NextResponse.json({
      success: true,
      editedTimes,
    });
  } catch (error) {
    console.error("Edit times error:", error);
    return NextResponse.json(
      { error: "Failed to save edited times" },
      { status: 500 },
    );
  }
}

function buildSlots(startHour = 10, endHour = 20, stepMinutes = 30) {
  const slots = [];
  for (let h = startHour; h < endHour; h++) {
    for (let m = 0; m < 60; m += stepMinutes) {
      slots.push(`${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`);
    }
  }
  return slots;
}
