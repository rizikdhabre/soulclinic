import { getCollection } from "@/lib/db";
import { NextResponse } from "next/server";
import { normalizeIsraeliPhone } from "@/lib/phone";

export async function GET(req) {
  try {
    const collection = await getCollection("usersData");

    const { searchParams } = new URL(req.url);
    const rawPhone = searchParams.get("phone");

    if (!rawPhone) {
      return NextResponse.json(
        { message: "Missing phone number" },
        { status: 400 }
      );
    }
    const phone = normalizeIsraeliPhone(rawPhone);
    if (!phone) {
      return NextResponse.json(
        { message: "Invalid phone number format" },
        { status: 400 }
      );
    }
    const user = await collection.findOne(
      { phone },
      { projection: { _id: 0, appointments: 1 } }
    );

    if (!user) {
      return NextResponse.json({ message: "User not found" }, { status: 404 });
    }

    const appointments = Array.isArray(user.appointments) ? user.appointments : [];
    appointments.sort((a, b) => {
      const da = `${a.date || ""} ${a.time || ""}`;
      const db = `${b.date || ""} ${b.time || ""}`;
      return da.localeCompare(db);
    });

    return NextResponse.json({ phone, appointments }, { status: 200 });
  } catch (error) {
    console.error("Error fetching user appointments", error);
    return NextResponse.json(
      { message: "Failed to fetch user appointments" },
      { status: 500 }
    );
  }
}
