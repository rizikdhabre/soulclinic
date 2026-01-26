import { getCollection } from "@/lib/db";
import { NextResponse } from "next/server";

export async function GET() {
  try {
    const usersCollection = await getCollection("usersData");

    const result = await usersCollection.aggregate([
      { $unwind: "$appointments" },
      {
        $match: {
          "appointments.cupsCount": { $exists: true },
          "appointments.attended": true,
        },
      },

      {
        $addFields: {
          month: {
            $substr: ["$appointments.date", 0, 7], 
          },
        },
      },
      {
        $group: {
          _id: "$month",
          totalCups: { $sum: "$appointments.cupsCount" },
        },
      },
      { $sort: { _id: 1 } },
    ]).toArray();

    return NextResponse.json(
      result.map((r) => ({
        month: r._id,
        cups: r.totalCups,
      }))
    );
  } catch (error) {
    console.error("Hujamah stats error:", error);
    return NextResponse.json(
      { error: "Failed to fetch Hujamah stats" },
      { status: 500 }
    );
  }
}
