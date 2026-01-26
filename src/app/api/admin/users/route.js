import { getCollection } from "@/lib/db";
import { NextResponse } from "next/server";

export async function GET() {
  try {
    const collection = await getCollection("usersData");
    const users = await collection.find({}).toArray();

    return NextResponse.json(
      users.map((u) => ({
        ...u,
        _id: u._id.toString(),
      })),
    );
  } catch (error) {
    console.error("Fetch users error:", error);
    return NextResponse.json(
      { error: "Failed to fetch users" },
      { status: 500 },
    );
  }
}
