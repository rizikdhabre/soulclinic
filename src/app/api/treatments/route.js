import { NextResponse } from "next/server";
import { getPublicTreatments } from "@/lib/catalogue/public";
export async function GET() {
  try {
    return NextResponse.json(await getPublicTreatments(), { headers: { "Cache-Control": "no-store", "X-Robots-Tag": "noindex" } });
  } catch {
    return NextResponse.json({ message: "Catalogue temporarily unavailable" }, { status: 503, headers: { "Cache-Control": "no-store" } });
  }
}
