import { getCollection } from "@/lib/db";
import { NextResponse } from "next/server";
import crypto from "crypto";

export async function POST(req) {
  const { phone, text } = await req.json();
  if (!phone || !text) {
    return NextResponse.json({ error: "Missing data" }, { status: 400 });
  }

  const users = await getCollection("usersData");

  const note = {
    id: crypto.randomUUID(),
    text,
    createdAt: new Date(),
    updatedAt: new Date(),
  };

  await users.updateOne(
    { phone },
    { $push: { adminNotes: note } }
  );

  return NextResponse.json(note);
}


export async function DELETE(req) {
  const { phone, noteId } = await req.json();

  const users = await getCollection("usersData");

  await users.updateOne(
    { phone },
    { $pull: { adminNotes: { id: noteId } } }
  );

  return NextResponse.json({ success: true });
}

export async function PUT(req) {
  const { phone, noteId, text } = await req.json();

  const users = await getCollection("usersData");

  await users.updateOne(
    { phone, "adminNotes.id": noteId },
    {
      $set: {
        "adminNotes.$.text": text,
        "adminNotes.$.updatedAt": new Date(),
      },
    }
  );

  return NextResponse.json({ success: true });
}
