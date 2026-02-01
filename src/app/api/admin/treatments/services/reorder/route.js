import { getCollection } from "@/lib/db";
import { NextResponse } from "next/server";
import { ObjectId } from "mongodb";

export async function PUT(req) {
  try {
    const { treatmentId, services } = await req.json();

    if (!treatmentId || !Array.isArray(services)) {
      return NextResponse.json(
        { message: "Invalid data" },
        { status: 400 }
      );
    }

    const collection = await getCollection("treatments");

    await collection.updateOne(
      { _id: new ObjectId(treatmentId) },
      {
        $set: {
          services,
          updatedAt: new Date(),
        },
      }
    );

    return NextResponse.json(
      { message: "Services reordered" },
      { status: 200 }
    );
  } catch (err) {
    console.error(err);
    return NextResponse.json(
      { message: "Failed to reorder services" },
      { status: 500 }
    );
  }
}
