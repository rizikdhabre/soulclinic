import { getCollection } from "@/lib/db";
import { NextResponse } from "next/server";
import { normalizeIsraeliPhone } from "@/lib/phone";

export async function GET(req) {
  try {
    const { searchParams } = new URL(req.url);
    const rawPhone = searchParams.get("phone");

    if (!rawPhone) {
      return NextResponse.json(
        { message: "Missing phone number" },
        { status: 400 },
      );
    }

    const phone = normalizeIsraeliPhone(rawPhone);

    if (!phone) {
      return NextResponse.json(
        { message: "Invalid phone number format" },
        { status: 400 },
      );
    }

    const usersCollection = await getCollection("usersData");
    const user = await usersCollection.findOne(
      { phone },
      { projection: { _id: 0, firstName: 1, lastName: 1 } },
    );

    return NextResponse.json({
      exists: !!user,
      phone,
      firstName: user?.firstName || "",
      lastName: user?.lastName || "",
    });
  } catch (error) {
    console.error("Lookup appointment user error:", error);
    return NextResponse.json(
      { message: "Failed to look up user" },
      { status: 500 },
    );
  }
}