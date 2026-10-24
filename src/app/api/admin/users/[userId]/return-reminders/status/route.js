import { NextResponse } from "next/server";
import { ObjectId } from "mongodb";
import { AdminAuthError, requireAdmin } from "@/lib/adminAuth";
import { normalizeIsraeliPhone } from "@/lib/phone";
import { getReturnReminderStatus } from "@/lib/returnReminderStatus";

const headers = { "Cache-Control": "private, no-store" };
const reply = (body, status = 200) => NextResponse.json(body, { status, headers });
const failure = (status, code) => Object.assign(new Error(code), { status, code });

export async function GET(request, context) {
  try {
    requireAdmin(request);
    const { userId } = await context.params;
    if (typeof userId !== "string" || !/^[a-f\d]{24}$/i.test(userId)) throw failure(400, "INVALID_USER_ID");
    const { getCollection } = await import("@/lib/db");
    const users = await getCollection("usersData");
    const user = await users.findOne({ _id: new ObjectId(userId) }, { projection: { phone: 1 } });
    if (!user) throw failure(404, "USER_NOT_FOUND");
    const phone = typeof user.phone === "string" ? normalizeIsraeliPhone(user.phone) : null;
    if (!phone) throw failure(400, "INVALID_PHONE");
    return reply(await getReturnReminderStatus({ phone }));
  } catch (error) {
    if (error instanceof AdminAuthError) return reply({ error: error.code, message: error.message }, error.status);
    const status = [400, 404].includes(error.status) ? error.status : 500;
    return reply({
      error: status === 500 ? "RETURN_REMINDER_STATUS_UNAVAILABLE" : error.code,
      message: status === 404 ? "الزبون غير موجود." : "تعذر تحميل تفاصيل التذكير. حاول مرة أخرى.",
    }, status);
  }
}
