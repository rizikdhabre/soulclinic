import { getCollection } from "@/lib/db";
import { NextResponse } from "next/server";
import { ObjectId } from "mongodb";
import { getStorage } from "firebase-admin/storage";

/* =========================
   POST – add sub-treatment
========================= */
export async function POST(req) {
  try {
    const { treatmentId, service } = await req.json();

    if (!treatmentId || !service?.title) {
      return NextResponse.json(
        { message: "Invalid service data" },
        { status: 400 }
      );
    }

    const collection = await getCollection("treatments");

    await collection.updateOne(
      { _id: new ObjectId(treatmentId) },
      {
        $push: { services: service },
        $set: { updatedAt: new Date() },
      }
    );

    return NextResponse.json(
      { message: "Service added successfully" },
      { status: 201 }
    );
  } catch (error) {
    console.error("Error adding service", error);
    return NextResponse.json(
      { message: "Failed to add service" },
      { status: 500 }
    );
  }
}

export async function PUT(req) {
  try {
    const { treatmentId, serviceIndex, service } = await req.json();

    if (
      !treatmentId ||
      serviceIndex === undefined ||
      typeof service !== "object"
    ) {
      return NextResponse.json(
        { message: "Invalid request data" },
        { status: 400 }
      );
    }

    const collection = await getCollection("treatments");

    const treatment = await collection.findOne({
      _id: new ObjectId(treatmentId),
    });

    const oldService = treatment?.services?.[serviceIndex];
    const oldImagePath = oldService?.imagePath;

    const updateFields = {};
    Object.keys(service).forEach((key) => {
      updateFields[`services.${serviceIndex}.${key}`] = service[key];
    });

    await collection.updateOne(
      { _id: new ObjectId(treatmentId) },
      {
        $set: updateFields,
        $currentDate: { updatedAt: true },
      }
    );
    if (
      oldImagePath &&
      service.imagePath &&
      oldImagePath !== service.imagePath
    ) {
      try {
        const bucket = getStorage().bucket();
        await bucket.file(oldImagePath).delete();
      } catch (err) {
        console.error("Failed to delete old image:", err.message);
      }
    }

    return NextResponse.json(
      { message: "Service updated successfully" },
      { status: 200 }
    );
  } catch (error) {
    console.error("Error updating service", error);
    return NextResponse.json(
      { message: "Failed to update service" },
      { status: 500 }
    );
  }
}

export async function DELETE(req) {
  try {
    const { treatmentId, serviceIndex } = await req.json();

    if (!treatmentId || serviceIndex === undefined) {
      return NextResponse.json(
        { message: "Invalid request data" },
        { status: 400 }
      );
    }

    const collection = await getCollection("treatments");

    const treatment = await collection.findOne({
      _id: new ObjectId(treatmentId),
    });

    const service = treatment?.services?.[serviceIndex];
    const imagePath = service?.imagePath;

    // 🔹 remove service
    await collection.updateOne(
      { _id: new ObjectId(treatmentId) },
      {
        $unset: { [`services.${serviceIndex}`]: 1 },
      }
    );

    await collection.updateOne(
      { _id: new ObjectId(treatmentId) },
      {
        $pull: { services: null },
        $set: { updatedAt: new Date() },
      }
    );

    // 🔥 DELETE IMAGE FROM FIREBASE
    if (imagePath) {
      try {
        const bucket = getStorage().bucket();
        await bucket.file(imagePath).delete();
      } catch (err) {
        console.error("Failed to delete image:", err.message);
      }
    }

    return NextResponse.json(
      { message: "Service deleted successfully" },
      { status: 200 }
    );
  } catch (error) {
    console.error("Error deleting service", error);
    return NextResponse.json(
      { message: "Failed to delete service" },
      { status: 500 }
    );
  }
}
