import { NextResponse } from "next/server";
import { verifyToken } from "@/lib/jwt";

export async function GET(req) {
  const token = req.cookies.get("token")?.value;
  if (!token) {
    return NextResponse.json({ isAdmin: false });
  }

  try {
    const payload = verifyToken(token);
    return NextResponse.json({
      isAdmin: payload.role === "admin",
    });
  } catch {
    return NextResponse.json({ isAdmin: false });
  }
}
