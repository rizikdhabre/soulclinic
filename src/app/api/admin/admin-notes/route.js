import { getCollection } from "@/lib/db";
import { NextResponse } from "next/server";
import crypto from "crypto";
import { withAdminRoute } from "@/lib/adminAuth";

async function createAdminNote(req) {
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


async function deleteAdminNote(req) {
  const { phone, noteId } = await req.json();

  const users = await getCollection("usersData");

  await users.updateOne(
    { phone },
    { $pull: { adminNotes: { id: noteId } } }
  );

  return NextResponse.json({ success: true });
}

async function updateAdminNote(req) {
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

export const POST = withAdminRoute(createAdminNote);
export const DELETE = withAdminRoute(deleteAdminNote);
export const PUT = withAdminRoute(updateAdminNote);
