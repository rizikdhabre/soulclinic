import { NextResponse } from "next/server";
import { getCollection } from "@/lib/db";

export async function POST(req) {
  try {
    const { date } = await req.json();

    if (!date) {
      return NextResponse.json(
        { message: "Missing date" },
        { status: 400 }
      );
    }

    const collection = await getCollection("appointments");

    await collection.updateOne(
      { date },
      { $set: { blockedTimes: [] } },
      { upsert: true }
    );

    return NextResponse.json({ success: true });
  } catch (error) {
    console.error("Unblock ALL error:", error);
    return NextResponse.json(
      { message: "Internal server error" },
      { status: 500 }
    );
  }
}
