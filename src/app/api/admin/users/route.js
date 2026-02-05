import { getCollection } from "@/lib/db";
import { ObjectId } from "mongodb";
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

export async function POST(req) {
  try {
    const body = await req.json(); 

    const { userId, firstName, lastName } = body;

    if (!userId || !firstName || !lastName) {
      return NextResponse.json({ error: "Missing fields" }, { status: 400 });
    }

    const collection = await getCollection("usersData");

    await collection.updateOne(
      { _id: new ObjectId(userId) },
      { $set: { firstName, lastName } },
    );

    return NextResponse.json({ success: true });
  } catch (error) {
    console.error("Update name error:", error);
    return NextResponse.json(
      { error: "Failed to update name" },
      { status: 500 },
    );
  }
}
