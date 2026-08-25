import { NextResponse } from "next/server";
import { clearCustomerSessionCookie } from "@/lib/customerSession";

export async function POST() {
  const response = NextResponse.json({ success: true });
  clearCustomerSessionCookie(response);
  return response;
}
