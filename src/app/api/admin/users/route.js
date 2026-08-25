import { getCollection } from "@/lib/db";
import { ObjectId } from "mongodb";
import { NextResponse } from "next/server";
import { normalizeIsraeliPhone } from "@/lib/phone";
import { withAdminRoute } from "@/lib/adminAuth";

async function getUsers(req) {
  try {
    const searchParams = new URL(req.url).searchParams;
    const hasPhoneQuery = searchParams.has("phone");
    const rawPhone = searchParams.get("phone");
    const phone = hasPhoneQuery ? normalizeIsraeliPhone(rawPhone) : null;

    if (hasPhoneQuery && !phone) {
      return NextResponse.json({ error: "INVALID_PHONE" }, { status: 400 });
    }

    const collection = await getCollection("usersData");

    if (phone) {
      const user = await collection.findOne(
        { phone },
        { projection: { _id: 0, firstName: 1, lastName: 1 } },
      );

      return NextResponse.json({
        exists: Boolean(user),
        phone,
        firstName: user?.firstName || "",
        lastName: user?.lastName || "",
      });
    }

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

async function updateUserName(req) {
  try {
    const body = await req.json();
    const { userId, firstName, lastName } = body;

    if (!userId || !firstName || !lastName) {
      return NextResponse.json({ error: "Missing fields" }, { status: 400 });
    }

    const usersCollection = await getCollection("usersData");
    const appointmentsCollection = await getCollection("appointments");

    const result = await usersCollection.findOneAndUpdate(
      { _id: new ObjectId(userId) },
      { $set: { firstName, lastName } },
      { returnDocument: "after", projection: { phone: 1 } }
    );

    const updatedUser = result?.value ?? result;

    if (!updatedUser?.phone) {
      return NextResponse.json(
        { error: "User phone not found" },
        { status: 404 }
      );
    }

    const phone = normalizeIsraeliPhone(updatedUser.phone);

    if (!phone) {
      return NextResponse.json(
        { error: "Invalid phone number" },
        { status: 400 }
      );
    }

    await appointmentsCollection.updateMany(
      { "appointments.phone": phone },
      {
        $set: {
          "appointments.$[apt].firstName": firstName,
          "appointments.$[apt].lastName": lastName,
        },
      },
      {
        arrayFilters: [{ "apt.phone": phone }],
      }
    );

    return NextResponse.json({ success: true });
  } catch (error) {
    console.error("Update name error:", error);
    return NextResponse.json(
      { error: "Failed to update name" },
      { status: 500 }
    );
  }
}

export const GET = withAdminRoute(getUsers);
export const POST = withAdminRoute(updateUserName);
