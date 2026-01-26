import { getCollection } from "@/lib/db";
import { NextResponse } from "next/server";

export async function GET() {
  try {
    const usersCollection = await getCollection("usersData");

    const result = await usersCollection.aggregate([
      { $unwind: "$appointments" },

      // ✅ ONLY attended appointments
      {
        $match: {
          "appointments.attended": true,
          "appointments.price": { $exists: true },
        },
      },

      // extract YYYY-MM from date
      {
        $addFields: {
          month: {
            $substr: ["$appointments.date", 0, 7],
          },
        },
      },

      // sum income per month
      {
        $group: {
          _id: "$month",
          income: { $sum: "$appointments.price" },
        },
      },

      { $sort: { _id: 1 } },
    ]).toArray();

    return NextResponse.json(
      result.map((r) => ({
        month: r._id,
        income: r.income,
      }))
    );
  } catch (error) {
    console.error("Income stats error:", error);
    return NextResponse.json(
      { error: "Failed to fetch income stats" },
      { status: 500 }
    );
  }
}
