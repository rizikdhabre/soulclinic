import { NextResponse } from "next/server";
import { bucket } from "@/lib/firebaseAdmin";

export async function POST(req) {
  try {
    const formData = await req.formData();

    const image = formData.get("image");
    const categoryId = formData.get("categoryId");

    if (!image) {
      return NextResponse.json(
        { error: "لم يتم اختيار صورة" },
        { status: 400 }
      );
    }

    if (!image.type.startsWith("image/")) {
      return NextResponse.json(
        { error: "الملف يجب أن يكون صورة فقط" },
        { status: 400 }
      );
    }
    const MAX_SIZE = 5 * 1024 * 1024;

    if (image.size > MAX_SIZE) {
      return NextResponse.json(
        { error: "حجم الصورة كبير جدًا (الحد الأقصى 5 ميجابايت)" },
        { status: 400 }
      );
    }
    const buffer = Buffer.from(await image.arrayBuffer());

    const filePath = `perfumes/${categoryId}/${Date.now()}.jpg`;
    const file = bucket.file(filePath);

    await file.save(buffer, {
      metadata: {
        contentType: image.type,
      },
    });

    await file.makePublic();

    const publicUrl = `https://storage.googleapis.com/${bucket.name}/${filePath}`;
    const cacheBustedUrl = `${publicUrl}?v=${Date.now()}`;

    return NextResponse.json({
      url: cacheBustedUrl,
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
