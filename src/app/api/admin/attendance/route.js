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
