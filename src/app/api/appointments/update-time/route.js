import { getCollection } from "@/lib/db";
import { NextResponse } from "next/server";
import { ObjectId } from "mongodb";

/* ---------------- UPDATE APPOINTMENT TIME ---------------- */

export async function POST(req) {
  try {
    const { appointmentId, date, newTime } = await req.json();

    if (!appointmentId || !date || !newTime) {
      return NextResponse.json(
        { error: "appointmentId, date and newTime are required" },
        { status: 400 }
      );
    }

    const apptObjectId = new ObjectId(appointmentId);

    /* ---------- 1. Update appointments collection ---------- */

    const appointmentsCollection = await getCollection("appointments");

    const updateAppointmentsResult =
      await appointmentsCollection.updateOne(
        {
          date,
          "appointments._id": apptObjectId,
        },
        {
          $set: {
            "appointments.$.time": newTime,
          },
        }
      );

    /* ---------- 2. Update usersData collection ---------- */

    const usersCollection = await getCollection("usersData");

    const updateUsersResult = await usersCollection.updateOne(
      {
        "appointments._id": apptObjectId,
      },
      {
        $set: {
          "appointments.$.time": newTime,
        },
      }
    );

    return NextResponse.json({
      success: true,
      updated: {
        appointments: updateAppointmentsResult.modifiedCount,
        usersData: updateUsersResult.modifiedCount,
      },
    });
  } catch (error) {
    console.error("Update appointment time error:", error);
    return NextResponse.json(
      { error: "Failed to update appointment time" },
      { status: 500 }
    );
  }
}
