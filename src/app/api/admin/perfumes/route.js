import { getCollection } from "@/lib/db";
import { NextResponse } from "next/server";
import { ObjectId } from "mongodb";
import { getStorage } from "firebase-admin/storage";

/* ================= GET ALL ================= */
export async function GET() {
  try {
    const collection = await getCollection("perfumeCategories");
    const categories = await collection.find({}).toArray();
    return NextResponse.json(categories);
  } catch (err) {
    console.error(err);
    return NextResponse.json({ message: "Failed" }, { status: 500 });
  }
}

/* ================= CREATE CATEGORY ================= */
export async function POST(req) {
  try {
    const { name, description } = await req.json();

    if (!name || !description) {
      return NextResponse.json({ message: "Missing data" }, { status: 400 });
    }

    const collection = await getCollection("perfumeCategories");

    const result = await collection.insertOne({
      name,
      description,
      perfumes: [],
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    return NextResponse.json({ id: result.insertedId }, { status: 201 });
  } catch (err) {
    console.error(err);
    return NextResponse.json({ message: "Failed" }, { status: 500 });
  }
}

export async function PUT(req) {
  try {
    const { id, name, description } = await req.json();

    const update = {};
    if (name) update.name = name;
    if (description) update.description = description;

    const collection = await getCollection("perfumeCategories");

    await collection.updateOne(
      { _id: new ObjectId(id) },
      { $set: { ...update, updatedAt: new Date() } }
    );

    return NextResponse.json({ message: "Updated" });
  } catch (err) {
    console.error(err);
    return NextResponse.json({ message: "Failed" }, { status: 500 });
  }
}

export async function DELETE(req) {
  try {
    const { id } = await req.json();

    const collection = await getCollection("perfumeCategories");

    const category = await collection.findOne({
      _id: new ObjectId(id),
    });

    const bucket = getStorage().bucket();

    for (const perfume of category.perfumes || []) {
      if (perfume.imagePath) {
        try {
          await bucket.file(perfume.imagePath).delete();
        } catch {}
      }
    }

    await collection.deleteOne({ _id: new ObjectId(id) });

    return NextResponse.json({ message: "Deleted" });
  } catch (err) {
    console.error(err);
    return NextResponse.json({ message: "Failed" }, { status: 500 });
  }
}
