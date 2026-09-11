import { getCollection } from "@/lib/db";
import { NextResponse } from "next/server";
import { ObjectId } from "mongodb";
import { getStorageBucket } from "@/lib/cloudStorage";

export async function POST(req) {
  try {
    const { categoryId, perfumeId } = await req.json();

    const collection = await getCollection("perfumeCategories");

    const category = await collection.findOne({
      _id: new ObjectId(categoryId),
    });

    const perfume = category.perfumes.find(
      (p) => p._id.toString() === perfumeId
    );

    if (perfume?.imagePath) {
      const bucket = await getStorageBucket();
      await bucket.file(perfume.imagePath).delete();
    }

    await collection.updateOne(
      {
        _id: new ObjectId(categoryId),
        "perfumes._id": new ObjectId(perfumeId),
      },
      {
        $set: {
          "perfumes.$.imageUrl": "",
          "perfumes.$.imagePath": "",
          updatedAt: new Date(),
        },
      }
    );

    return NextResponse.json({ message: "Image deleted" });
  } catch {
    console.error("Failed to delete perfume image");
    return NextResponse.json(
      { message: "Failed" },
      { status: 500 }
    );
  }
}
