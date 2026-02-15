import { getCollection } from "@/lib/db";
import { NextResponse } from "next/server";

export async function GET() {
  try {
    const collection = await getCollection("perfumeCategories");

    const categories = await collection.find({}).toArray();

    const formatted = categories.map((cat) => ({
      _id: cat._id,
      name: cat.name,
      description: cat.description,
      perfumes: (cat.perfumes || []).slice(0, 4), // 👈 ONLY FIRST 4
    }));

    return NextResponse.json(formatted);
  } catch (err) {
    console.error(err);
    return NextResponse.json({ message: "Failed" }, { status: 500 });
  }
}
