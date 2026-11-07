import { getCollection } from "@/lib/db";
import { NextResponse } from "next/server";
import { ObjectId } from "mongodb";
import { getStorageBucket } from "@/lib/cloudStorage";
import { advanceTreatmentCatalogCacheGeneration } from "@/lib/cache/redisReadCache";

export async function POST(req) {
  try {
    const { treatmentId, serviceId, serviceIndex } = await req.json();
    const index = typeof serviceIndex === "number" || (typeof serviceIndex === "string" && /^\d+$/.test(serviceIndex))
      ? Number(serviceIndex) : NaN;

    if (!treatmentId || (serviceId !== undefined
      ? typeof serviceId !== "string" || !serviceId || serviceId.length > 128
      : !Number.isSafeInteger(index) || index < 0)) {
      return NextResponse.json(
        { message: "Invalid data" },
        { status: 400 }
      );
    }

    const collection = await getCollection("treatments");

    const treatment = await collection.findOne({
      _id: new ObjectId(treatmentId),
    });

    const service = serviceId !== undefined
      ? treatment?.services?.find((entry) => String(entry?._id) === serviceId)
      : treatment?.services?.[index];
    if (!service) return NextResponse.json({ message: "Service not found" }, { status: 404 });
    const imagePath = service?.imagePath;

    const fieldPrefix = serviceId !== undefined ? "services.$[target]" : `services.${index}`;
    const result = await collection.updateOne(
      { _id: new ObjectId(treatmentId), ...(serviceId !== undefined
        ? { services: { $elemMatch: service } }
        : { services: treatment.services }) },
      {
        $set: {
          [`${fieldPrefix}.imageUrl`]: "",
          [`${fieldPrefix}.imagePath`]: "",
          updatedAt: new Date(),
        },
      },
      serviceId !== undefined ? { arrayFilters: [{ "target._id": service._id }] } : {},
    );
    if (!result.matchedCount) return NextResponse.json({ message: "Service changed; reload and retry" }, { status: 409 });
    await advanceTreatmentCatalogCacheGeneration().catch(() => false);

    if (imagePath) {
      try {
        const bucket = await getStorageBucket();
        await bucket.file(imagePath).delete();
      } catch {
        console.error("Failed to delete old service image file");
      }
    }

    return NextResponse.json(
      { message: "Image deleted" },
      { status: 200 }
    );
  } catch {
    console.error("Failed to delete service image");
    return NextResponse.json(
      { message: "Failed to delete image" },
      { status: 500 }
    );
  }
}
