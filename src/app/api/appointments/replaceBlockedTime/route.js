import { NextResponse } from "next/server";
import { getCollection } from "@/lib/db";

export async function POST(req) {
  try {
    const { date, oldTime, newTime } = await req.json();

    if (!date || !oldTime || !newTime) {
      return NextResponse.json(
        { error: "date, oldTime, newTime are required" },
        { status: 400 },
      );
    }

    const collection = await getCollection("appointments");

    // ✅ MUST be an update PIPELINE to use $map/$cond expressions
    await collection.updateOne(
      { date },
      [
        {
          $set: {
            blockedTimes: {
              $let: {
                vars: {
                  bt: { $ifNull: ["$blockedTimes", []] },
                },
                in: {
                  $map: {
                    input: "$$bt",
                    as: "t",
                    in: {
                      $cond: [{ $eq: ["$$t", oldTime] }, newTime, "$$t"],
                    },
                  },
                },
              },
            },
          },
        },
      ],
      { upsert: true },
    );

    return NextResponse.json({ success: true });
  } catch (err) {
    console.error("replaceBlockedTime error:", err);
    return NextResponse.json(
      { error: "Failed to replace blocked time" },
      { status: 500 },
    );
  }
}
