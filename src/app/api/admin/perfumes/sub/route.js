import { getCollection } from "@/lib/db";
import { NextResponse } from "next/server";
import { ObjectId } from "mongodb";
import { getStorage } from "firebase-admin/storage";

/* ================= ADD PERFUME ================= */
export async function POST(req) {
  try {
    const { categoryId, perfume } = await req.json();

    if (!categoryId || !perfume?.name) {
      return NextResponse.json({ message: "Invalid data" }, { status: 400 });
    }

    const collection = await getCollection("perfumeCategories");
    const newPerfume = {
      _id: new ObjectId(),
      name: perfume.name,
      description: perfume.description || "",
      price: perfume.price,
      size: perfume.size,
      imageUrl: perfume.imageUrl || "",
      imagePath: perfume.imagePath || "",
      createdAt: new Date(),
    };

    await collection.updateOne(
      { _id: new ObjectId(categoryId) },
      {
        $push: { perfumes: newPerfume },
        $set: { updatedAt: new Date() },
      },
    );

    return NextResponse.json(newPerfume, { status: 201 });
  } catch (err) {
    console.error(err);
    return NextResponse.json({ message: "Failed" }, { status: 500 });
  }
}

/* ================= UPDATE PERFUME ================= */
export async function PUT(req) {
  try {
    const { categoryId, perfumeId, perfume } = await req.json();

    const collection = await getCollection("perfumeCategories");

    const category = await collection.findOne({
      _id: new ObjectId(categoryId),
    });

    const old = category.perfumes.find((p) => p._id.toString() === perfumeId);
    const oldPath = old?.imagePath;

    await collection.updateOne(
      {
        _id: new ObjectId(categoryId),
        "perfumes._id": new ObjectId(perfumeId),
      },
      {
        $set: {
          "perfumes.$.name": perfume.name,
          "perfumes.$.description": perfume.description || "", 
          "perfumes.$.price": perfume.price,
          "perfumes.$.size": perfume.size,
          "perfumes.$.imageUrl": perfume.imageUrl,
          "perfumes.$.imagePath": perfume.imagePath,
          updatedAt: new Date(),
        },
      },
    );

    if (oldPath && oldPath !== perfume.imagePath) {
      try {
        const bucket = getStorage().bucket();
        await bucket.file(oldPath).delete();
      } catch {}
    }

    return NextResponse.json({ message: "Updated" });
  } catch (err) {
    console.error(err);
    return NextResponse.json({ message: "Failed" }, { status: 500 });
  }
}

/* ================= DELETE PERFUME ================= */
export async function DELETE(req) {
  try {
    const { categoryId, perfumeId } = await req.json();

    const collection = await getCollection("perfumeCategories");

    const category = await collection.findOne({
      _id: new ObjectId(categoryId),
    });

    const perfume = category.perfumes.find(
      (p) => p._id.toString() === perfumeId,
    );

    if (perfume?.imagePath) {
      const bucket = getStorage().bucket();
      await bucket.file(perfume.imagePath).delete();
    }

    await collection.updateOne(
      { _id: new ObjectId(categoryId) },
      {
        $pull: { perfumes: { _id: new ObjectId(perfumeId) } },
        $set: { updatedAt: new Date() },
      },
    );

    return NextResponse.json({ message: "Deleted" });
  } catch (err) {
    console.error(err);
    return NextResponse.json({ message: "Failed" }, { status: 500 });
  }
}
