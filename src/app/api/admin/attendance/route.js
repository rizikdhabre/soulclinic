import { getCollection } from "@/lib/db";
import { NextResponse } from "next/server";
import { ObjectId } from "mongodb";

export async function PATCH(req) {
  try {
    const { appointmentId, attended } = await req.json();

    if (!appointmentId || typeof attended !== "boolean") {
      return NextResponse.json(
        { error: "Invalid payload" },
        { status: 400 }
      );
    }
    const usersCollection = await getCollection("usersData");
    const result = await usersCollection.updateOne(
      { "appointments._id": new ObjectId(appointmentId) }, 
      {
        $set: {
          "appointments.$.attended": attended,
        },
      }
    );

    if (result.matchedCount === 0) {
      return NextResponse.json(
        { error: "Appointment not found" },
        { status: 404 }
      );
    }

    return NextResponse.json({ success: true });
  } catch (error) {
    console.error("Attendance update failed:", error);
    return NextResponse.json(
      { error: "Server error" },
      { status: 500 }
    );
  }
}


export async function GET(req) {
  try {
    const { searchParams } = new URL(req.url);
    const type = searchParams.get("type");
    const offset = Number(searchParams.get("offset") || 0);
    const limit = Number(searchParams.get("limit") || 20);

    if (type !== "attended") {
      return NextResponse.json({ items: [], hasMore: false });
    }

    const usersCollection = await getCollection("usersData");
    const today = new Date().toISOString().split("T")[0];

    const pipeline = [
      { $unwind: "$appointments" },
      {
        $match: {
          "appointments.attended": true,
          "appointments.date": { $lte: today },
        },
      },
      {
        $project: {
          _id: 0,
          appointmentId: "$appointments._id",
          phone: "$phone",
          date: "$appointments.date",
          time: "$appointments.time",
          fullName: {
            $trim: {
              input: { $concat: ["$firstName", " ", "$lastName"] },
            },
          },
        },
      },
      { $sort: { date: -1, time: -1 } },
      { $skip: offset },
      { $limit: limit + 1 },
    ];

    const rows = await usersCollection.aggregate(pipeline).toArray();
    const hasMore = rows.length > limit;
    const items = rows.slice(0, limit).map((r) => ({
      ...r,
      appointmentId: r.appointmentId?.toString?.() || "",
    }));

    return NextResponse.json({ items, hasMore });
  } catch (error) {
    console.error("Failed to fetch attended appointments:", error);
    return NextResponse.json({ error: "Server error" }, { status: 500 });
  }
}