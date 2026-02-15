import { getCollection } from "@/lib/db";
import { NextResponse } from "next/server";
import { ObjectId } from "mongodb";

export async function PUT(req) {
  try {
    const { categoryId, order } = await req.json();

    const collection = await getCollection("perfumeCategories");

    const category = await collection.findOne({
      _id: new ObjectId(categoryId),
    });

    if (!category) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }

    const perfumesMap = new Map(
      (category.perfumes || []).map((p) => [p._id.toString(), p])
    );

    const reordered = order.map((id) =>
      perfumesMap.get(id.toString())
    );

    await collection.updateOne(
      { _id: new ObjectId(categoryId) },
      { $set: { perfumes: reordered } }
    );

    return NextResponse.json({ message: "Reordered" });
  } catch (err) {
    return NextResponse.json({ error: "Failed" }, { status: 500 });
  }
}
