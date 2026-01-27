import { getCollection } from "@/lib/db";
import { NextResponse } from "next/server";
import { ObjectId } from "mongodb";
import { getStorage } from "firebase-admin/storage";
export async function GET() {
  try {
    const collection = await getCollection("treatments");
    const treatments = await collection.find({}).toArray();

    return NextResponse.json(treatments, { status: 200 });
  } catch (error) {
    console.error("Error in fetching treatments", error);
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

    return NextResponse.json(
      { message: "Treatment updated successfully" },
      { status: 200 },
    );
  } catch (error) {
    console.error("Error updating treatment", error);
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

    return NextResponse.json(
      {
        message: "Treatment created successfully",
        id: result.insertedId,
      },
      { status: 201 },
    );
  } catch (error) {
    console.error("Error creating treatment", error);
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
      const bucket = getStorage().bucket();

      await Promise.all(
        imagePaths.map(async (path) => {
          try {
            await bucket.file(path).delete();
          } catch (err) {
            console.error("Failed to delete image:", path, err.message);
          }
        }),
      );
    }

    await collection.deleteOne({ _id: new ObjectId(id) });

    return NextResponse.json(
      {
        message: "Treatment and all sub-treatment images deleted successfully",
      },
      { status: 200 },
    );
  } catch (error) {
    console.error("Error deleting treatment", error);
    return NextResponse.json(
      { message: "Failed to delete treatment" },
      { status: 500 },
    );
  }
}
