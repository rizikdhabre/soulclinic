import { NextResponse } from "next/server";
import { getCollection } from "@/lib/db";
import { getStorageBucket } from "@/lib/cloudStorage";
import {
  advanceHeroCacheGeneration,
  getHomepageHeroWithCache,
} from "@/lib/cache/redisReadCache";

export async function POST(req) {
  try {
    const formData = await req.formData();
    const image = formData.get("image");

    if (!image) {
      return NextResponse.json(
        { message: "No image provided" },
        { status: 400 }
      );
    }

    const collection = await getCollection("settings");

    const existingSettings = await collection.findOne({ key: "homepage" });

    const oldImagePath = existingSettings?.heroImagePath || null;

    const buffer = Buffer.from(await image.arrayBuffer());

    const filePath = `homepage/hero-${Date.now()}.jpg`;
    const bucket = await getStorageBucket();
    const file = bucket.file(filePath);

    await file.save(buffer, {
      metadata: { contentType: image.type },
      public: true,
      resumable: false,
    });

    const imageUrl = `https://storage.googleapis.com/${bucket.name}/${filePath}`;

    if (!existingSettings) {
      await collection.insertOne({
        key: "homepage",
        heroImageUrl: imageUrl,
        heroImagePath: filePath,
        createdAt: new Date(),
        updatedAt: new Date(),
      });
    } else {
      await collection.updateOne(
        { key: "homepage" },
        {
          $set: {
            heroImageUrl: imageUrl,
            heroImagePath: filePath,
            updatedAt: new Date(),
          },
        }
      );
    }

    await advanceHeroCacheGeneration().catch(() => false);

    if (oldImagePath) {
      try {
        await bucket.file(oldImagePath).delete();
      } catch {
        console.error("Failed to delete old hero image");
      }
    }

    return NextResponse.json(
      {
        message: "Hero image saved successfully",
        url: imageUrl,
        path: filePath,
        isFirstUpload: !existingSettings,
      },
      { status: 200 }
    );
  } catch {
    console.error("Error uploading hero image");
    return NextResponse.json(
      { message: "Failed to upload hero image" },
      { status: 500 }
    );
  }
}

export async function GET() {
  try {
    const hero = await getHomepageHeroWithCache(async () => {
      const collection = await getCollection("settings");
      const settings = await collection.findOne({ key: "homepage" });

      return {
        heroImageUrl: settings?.heroImageUrl || null,
      };
    });

    return NextResponse.json(hero, { status: 200 });
  } catch {
    console.error("Error fetching hero image");
    return NextResponse.json(
      { message: "Failed to fetch hero image" },
      { status: 500 }
    );
  }
}
