import { getCollection } from "@/lib/db";
import { NextResponse } from "next/server";
import { ObjectId } from "mongodb";
import { getStorage } from "firebase-admin/storage";

export async function POST(req) {
  try {
    const { treatmentId, serviceIndex } = await req.json();

    if (!treatmentId || serviceIndex === undefined) {
      return NextResponse.json(
        { message: "Invalid data" },
        { status: 400 }
      );
    }

    const collection = await getCollection("treatments");

    const treatment = await collection.findOne({
      _id: new ObjectId(treatmentId),
    });

    const service = treatment?.services?.[serviceIndex];
    const imagePath = service?.imagePath;

    if (imagePath) {
      const bucket = getStorage().bucket();
      await bucket.file(imagePath).delete();
    }

    await collection.updateOne(
      { _id: new ObjectId(treatmentId) },
      {
        $set: {
          [`services.${serviceIndex}.imageUrl`]: "",
          [`services.${serviceIndex}.imagePath`]: "",
          updatedAt: new Date(),
        },
      }
    );

    return NextResponse.json(
      { message: "Image deleted" },
      { status: 200 }
    );
  } catch (err) {
    console.error(err);
    return NextResponse.json(
      { message: "Failed to delete image" },
      { status: 500 }
    );
  }
}
