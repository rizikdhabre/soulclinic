import { getCollection } from "@/lib/db";
import { NextResponse } from "next/server";
import { ObjectId } from "mongodb";

export async function GET(req) {
  try {
    const { searchParams } = new URL(req.url);
    const id = searchParams.get("id");

    if (!id) {
      return NextResponse.json(
        { message: "Missing treatment id" },
        { status: 400 }
      );
    }

    const collection = await getCollection("treatments");


    const treatment = await collection.findOne({
      _id: new ObjectId(id),
    });

    if (!treatment) {
      return NextResponse.json(
        { message: "Treatment not found" },
        { status: 404 }
      );
    }

    return NextResponse.json(treatment, { status: 200 });
  } catch (error) {
    console.error("Error fetching treatment", error);
    return NextResponse.json(
      { message: "Failed to fetch treatment" },
      { status: 500 }
    );
  }
}
