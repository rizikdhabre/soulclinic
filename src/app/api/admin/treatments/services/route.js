import { getCollection } from "@/lib/db";
import { NextResponse } from "next/server";
import { ObjectId } from "mongodb";
import { getStorageBucket } from "@/lib/cloudStorage";
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

const validServiceId = (value) => typeof value === "string" && value.length > 0 && value.length <= 128;

function findService(treatment, serviceId, serviceIndex) {
  return serviceId !== undefined
    ? treatment?.services?.find((service) => String(service?._id) === serviceId)
    : treatment?.services?.[parseServiceIndex(serviceIndex)];
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

    const newService = { ...service, _id: new ObjectId().toHexString() };
    const result = await collection.updateOne(
      { _id: new ObjectId(treatmentId) },
      {
        $push: { services: newService },
        $set: { updatedAt: new Date() },
      }
    );
    if (!result.matchedCount) return NextResponse.json({ message: "Treatment not found" }, { status: 404 });
    await advanceTreatmentCatalogCacheGeneration().catch(() => false);

    return NextResponse.json(
      { message: "Service added successfully", service: newService },
      { status: 201 }
    );
  } catch {
    console.error("Error adding service");
    return NextResponse.json(
      { message: "Failed to add service" },
      { status: 500 }
    );
  }
}

export async function PUT(req) {
  try {
    const { treatmentId, serviceId, serviceIndex, service } = await req.json();

    if (
      !treatmentId ||
      (serviceId !== undefined ? !validServiceId(serviceId) : parseServiceIndex(serviceIndex) === null) ||
      !service || typeof service !== "object" || Array.isArray(service)
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

    const oldService = findService(treatment, serviceId, serviceIndex);
    if (!oldService) return NextResponse.json({ message: "Service not found" }, { status: 404 });
    const oldImagePath = oldService?.imagePath;

    const updateFields = {};
    const fieldPrefix = serviceId !== undefined ? "services.$[target]" : `services.${parseServiceIndex(serviceIndex)}`;
    Object.keys(service).forEach((key) => {
      if (key !== "_id" && key !== "__key") updateFields[`${fieldPrefix}.${key}`] = service[key];
    });

    const result = await collection.updateOne(
      { _id: new ObjectId(treatmentId), ...(serviceId !== undefined
        ? { "services._id": oldService._id }
        : { services: treatment.services }) },
      {
        $set: updateFields,
        $currentDate: { updatedAt: true },
      },
      serviceId !== undefined ? { arrayFilters: [{ "target._id": oldService._id }] } : {},
    );
    if (!result.matchedCount) return NextResponse.json({ message: "Service changed; reload and retry" }, { status: 409 });
    await advanceTreatmentCatalogCacheGeneration().catch(() => false);

    if (
      oldImagePath &&
      service.imagePath &&
      oldImagePath !== service.imagePath
    ) {
      try {
        const bucket = await getStorageBucket();
        await bucket.file(oldImagePath).delete();
      } catch {
        console.error("Failed to delete old image");
      }
    }

    return NextResponse.json(
      { message: "Service updated successfully" },
      { status: 200 }
    );
  } catch {
    console.error("Error updating service");
    return NextResponse.json(
      { message: "Failed to update service" },
      { status: 500 }
    );
  }
}

export async function DELETE(req) {
  try {
    const { treatmentId, serviceId, serviceIndex } = await req.json();
    const targetServiceIndex = parseServiceIndex(serviceIndex);

    if (!treatmentId || (serviceId !== undefined ? !validServiceId(serviceId) : targetServiceIndex === null)) {
      return NextResponse.json(
        { message: "Invalid request data" },
        { status: 400 }
      );
    }

    const collection = await getCollection("treatments");

    const treatment = await collection.findOne({
      _id: new ObjectId(treatmentId),
    });

    const service = findService(treatment, serviceId, targetServiceIndex);
    if (!service) return NextResponse.json({ message: "Service not found" }, { status: 404 });
    const imagePath = service?.imagePath;

    const result = await collection.updateOne(
      { _id: new ObjectId(treatmentId), ...(serviceId !== undefined
        ? { "services._id": service._id }
        : { services: treatment.services }) },
      serviceId !== undefined
        ? { $pull: { services: { _id: service._id } }, $currentDate: { updatedAt: true } }
        : { $set: { services: treatment.services.filter((_, index) => index !== targetServiceIndex) }, $currentDate: { updatedAt: true } },
    );
    if (!result.matchedCount) return NextResponse.json({ message: "Service changed; reload and retry" }, { status: 409 });
    await advanceTreatmentCatalogCacheGeneration().catch(() => false);

    if (imagePath) {
      try {
        const bucket = await getStorageBucket();
        await bucket.file(imagePath).delete();
      } catch {
        console.error("Failed to delete image");
      }
    }

    return NextResponse.json(
      { message: "Service deleted successfully" },
      { status: 200 }
    );
  } catch {
    console.error("Error deleting service");
    return NextResponse.json(
      { message: "Failed to delete service" },
      { status: 500 }
    );
  }
}
