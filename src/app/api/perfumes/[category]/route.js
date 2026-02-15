import { getCollection } from "@/lib/db";
import { NextResponse } from "next/server";

export async function GET(req, context) {
  try {
    const { category } = await context.params;

    const collection = await getCollection("perfumeCategories");

    const categoryDoc = await collection.findOne({
      name: { $regex: `^${category}$`, $options: "i" },
    });

    if (!categoryDoc) {
      return NextResponse.json(
        { message: "Category not found" },
        { status: 404 }
      );
    }

    return NextResponse.json({
      _id: categoryDoc._id,
      name: categoryDoc.name,
      description: categoryDoc.description,
      perfumes: categoryDoc.perfumes || [],
    });
  } catch (err) {
    console.error(err);
    return NextResponse.json({ message: "Failed" }, { status: 500 });
  }
}
