import { getCollection } from "@/lib/db";
import { NextResponse } from "next/server";
import { ObjectId } from "mongodb";
import { getStorage } from "firebase-admin/storage";
import { advanceTreatmentCatalogCacheGeneration } from "@/lib/cache/redisReadCache";

function parseServiceIndex(value) {
  const index =
    typeof value === "number"
      ? value
      : typeof value === "string" && /^\d+$/.test(value)
        ? Number(value)
        : Number.NaN;

  return Number.isSafeInteger(index) && index >= 0 ? index : null;
}

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
    await advanceTreatmentCatalogCacheGeneration().catch(() => false);

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
    await advanceTreatmentCatalogCacheGeneration().catch(() => false);

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
    const targetServiceIndex = parseServiceIndex(serviceIndex);

    if (!treatmentId || targetServiceIndex === null) {
      return NextResponse.json(
        { message: "Invalid request data" },
        { status: 400 }
      );
    }

    const collection = await getCollection("treatments");

    const treatment = await collection.findOne({
      _id: new ObjectId(treatmentId),
    });

    const service = treatment?.services?.[targetServiceIndex];
    const imagePath = service?.imagePath;

    await collection.updateOne(
      { _id: new ObjectId(treatmentId) },
      [
        {
          $set: {
            services: {
              $let: {
                vars: { services: { $ifNull: ["$services", []] } },
                in: {
                  $map: {
                    input: {
                      $filter: {
                        input: { $range: [0, { $size: "$$services" }] },
                        as: "serviceIndex",
                        cond: {
                          $ne: ["$$serviceIndex", targetServiceIndex],
                        },
                      },
                    },
                    as: "serviceIndex",
                    in: {
                      $arrayElemAt: ["$$services", "$$serviceIndex"],
                    },
                  },
                },
              },
            },
            updatedAt: "$$NOW",
          },
        },
      ]
    );
    await advanceTreatmentCatalogCacheGeneration().catch(() => false);

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
