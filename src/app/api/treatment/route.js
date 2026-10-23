import { NextResponse } from "next/server";
import { getPublicTreatment } from "@/lib/catalogue/public";
export async function GET(req) {
  try {
    const record = await getPublicTreatment(new URL(req.url).searchParams.get("id"));
    return NextResponse.json(record || { message: "Treatment not found" }, { status: record ? 200 : 404, headers: { "Cache-Control": "no-store", "X-Robots-Tag": "noindex" } });
  } catch {
    return NextResponse.json({ message: "Catalogue temporarily unavailable" }, { status: 503, headers: { "Cache-Control": "no-store" } });
  }
}
