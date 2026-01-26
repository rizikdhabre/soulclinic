import { NextResponse } from "next/server";
import { getCollection } from "@/lib/db";

export async function POST(req) {
  try {
    const { date, time, block } = await req.json();

    if (!date || !time || typeof block !== "boolean") {
      return NextResponse.json(
        { message: "Missing required fields" },
        { status: 400 },
      );
    }

    const collection = await getCollection("appointments");

    const update = block
      ? { $addToSet: { blockedTimes: time } }
      : { $pull: { blockedTimes: time } };

    await collection.updateOne(
      { date },
      update,
      { upsert: true },
    );

    return NextResponse.json({ success: true });
  } catch (error) {
    console.error("Block appointment error:", error);
    return NextResponse.json(
      { message: "Internal server error" },
      { status: 500 },
    );
  }
}
