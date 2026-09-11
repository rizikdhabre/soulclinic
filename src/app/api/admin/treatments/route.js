import { getCollection } from "@/lib/db";
import { NextResponse } from "next/server";
import { ObjectId } from "mongodb";
import { getStorageBucket } from "@/lib/cloudStorage";
import {
  advanceTreatmentCatalogCacheGeneration,
  getTreatmentCatalogWithCache,
} from "@/lib/cache/redisReadCache";
export async function GET() {
  try {
    const treatments = await getTreatmentCatalogWithCache(async () => {
      const collection = await getCollection("treatments");
      return collection.find({}).toArray();
    });

    return NextResponse.json(treatments, { status: 200 });
  } catch {
    console.error("Error in fetching treatments");
    return NextResponse.json(
      { message: "Failed to fetch treatments" },
      { status: 500 },
    );
  }
}

export async function PUT(req) {
  try {
    const { id, title, description } = await req.json();

    if (!id) {
      return NextResponse.json({ message: "Missing id" }, { status: 400 });
    }

    const update = {};
    if (title !== undefined) update.title = title;
    if (description !== undefined) update.description = description;

    if (Object.keys(update).length === 0) {
      return NextResponse.json(
        { message: "Nothing to update" },
        { status: 400 },
      );
    }

    const collection = await getCollection("treatments");

    await collection.updateOne({ _id: new ObjectId(id) }, { $set: update });
    await advanceTreatmentCatalogCacheGeneration().catch(() => false);

    return NextResponse.json(
      { message: "Treatment updated successfully" },
      { status: 200 },
    );
  } catch {
    console.error("Error updating treatment");
    return NextResponse.json(
      { message: "Failed to update treatment" },
      { status: 500 },
    );
  }
}

export async function POST(req) {
  try {
    const body = await req.json();
    const { title, description, services } = body;

    if (!title || !description) {
      return NextResponse.json(
        { message: "Title and description are required" },
        { status: 400 },
      );
    }

    const collection = await getCollection("treatments");

    const newTreatment = {
      title,
      description,
      services: Array.isArray(services) ? services : [],
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    const result = await collection.insertOne(newTreatment);
    await advanceTreatmentCatalogCacheGeneration().catch(() => false);

    return NextResponse.json(
      {
        message: "Treatment created successfully",
        id: result.insertedId,
      },
      { status: 201 },
    );
  } catch {
    console.error("Error creating treatment");
    return NextResponse.json(
      { message: "Failed to create treatment" },
      { status: 500 },
    );
  }
}

export async function DELETE(req) {
  try {
    const { id } = await req.json();

    if (!id) {
      return NextResponse.json(
        { message: "Missing treatment id" },
        { status: 400 },
      );
    }

    const collection = await getCollection("treatments");

    const treatment = await collection.findOne({
      _id: new ObjectId(id),
    });

    if (!treatment) {
      return NextResponse.json(
        { message: "Treatment not found" },
        { status: 404 },
      );
    }

    const imagePaths = (treatment.services || [])
      .map((service) => service?.imagePath)
      .filter(Boolean);

    if (imagePaths.length > 0) {
      const bucket = await getStorageBucket();

      await Promise.all(
        imagePaths.map(async (path) => {
          try {
            await bucket.file(path).delete();
          } catch {
            console.error("Failed to delete treatment image");
          }
        }),
      );
    }

    await collection.deleteOne({ _id: new ObjectId(id) });
    await advanceTreatmentCatalogCacheGeneration().catch(() => false);

    return NextResponse.json(
      {
        message: "Treatment and all sub-treatment images deleted successfully",
      },
      { status: 200 },
    );
  } catch {
    console.error("Error deleting treatment");
    return NextResponse.json(
      { message: "Failed to delete treatment" },
      { status: 500 },
    );
  }
}
