import { NextResponse } from "next/server";
import { withAdminRoute } from "@/lib/adminAuth";
import { getAdminCustomerProfile } from "@/lib/adminCustomerProfile";

export const GET = withAdminRoute(async function GET(request, context) {
  try {
    const { userId } = await context.params;
    return NextResponse.json(await getAdminCustomerProfile(userId), { headers: { "Cache-Control": "private, no-store" } });
  } catch (error) {
    const status = [400, 404].includes(error.status) ? error.status : 500;
    const code = status === 400 ? "INVALID_USER_ID" : status === 404 ? "USER_NOT_FOUND" : "PROFILE_UNAVAILABLE";
    const message = status === 404 ? "الزبون غير موجود." : status === 400 ? "معرّف الزبون غير صالح." : "تعذر تحميل ملف الزبون. حاول مرة أخرى.";
    return NextResponse.json({ error: code, message }, { status, headers: { "Cache-Control": "private, no-store" } });
  }
});
