import { NextResponse } from "next/server";
import { bucket } from "@/lib/firebaseAdmin";

export async function POST(req) {
  try {


    const formData = await req.formData();

    const image = formData.get("image");
    const treatmentId = formData.get("treatmentId");
    const serviceIndex = formData.get("serviceIndex");

    if (!image) {
      return NextResponse.json(
        { error: "No image provided" },
        { status: 400 }
      );
    }

    if (!image.type.startsWith("image/")) {
      return NextResponse.json(
        { error: "Invalid file type" },
        { status: 400 }
      );
    }

    const buffer = Buffer.from(await image.arrayBuffer());

    const filePath = `treatments/${treatmentId}/services/${serviceIndex}/main.jpg`;
    const file = bucket.file(filePath);

    await file.save(buffer, {
      metadata: {
        contentType: image.type,
      },
    });

    await file.makePublic();

    const publicUrl = `https://storage.googleapis.com/${bucket.name}/${filePath}`;

    return NextResponse.json({
      url: publicUrl,
      path: filePath,
    });
  } catch (err) {
    console.error("UPLOAD ERROR:", err);
    return NextResponse.json(
      { error: "Upload failed" },
      { status: 500 }
    );
  }
}
