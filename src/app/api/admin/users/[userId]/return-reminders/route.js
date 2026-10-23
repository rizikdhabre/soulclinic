import { NextResponse } from "next/server";
import { ObjectId } from "mongodb";
import { AdminAuthError, requireAdmin } from "@/lib/adminAuth";
import { normalizeIsraeliPhone } from "@/lib/phone";
import { getReturnReminderPreference, setReturnReminderPreference } from "@/lib/returnReminderPreferences";

const headers = { "Cache-Control": "private, no-store" };
const reply = (body, status = 200) => NextResponse.json(body, { status, headers });
const failure = (status, code) => Object.assign(new Error(code), { status, code });

async function handlePreference(request, context, update) {
  try {
    const admin = requireAdmin(request);
    const { userId } = await context.params;
    if (typeof userId !== "string" || !/^[a-f\d]{24}$/i.test(userId)) throw failure(400, "INVALID_USER_ID");

    let body;
    if (update) {
      try { body = await request.json(); } catch { throw failure(400, "INVALID_JSON"); }
      if (!body || Array.isArray(body) || typeof body.enabled !== "boolean") throw failure(400, "INVALID_PREFERENCE");
      if (body.enabled && body.consentConfirmed !== true) throw failure(400, "CONSENT_REQUIRED");
    }

    const { getCollection } = await import("@/lib/db");
    const users = await getCollection("usersData");
    const user = await users.findOne({ _id: new ObjectId(userId) }, { projection: { phone: 1 } });
    if (!user) throw failure(404, "USER_NOT_FOUND");
    const phone = typeof user.phone === "string" ? normalizeIsraeliPhone(user.phone) : null;
    if (!phone) throw failure(400, "INVALID_PHONE");

    const preference = update
      ? await setReturnReminderPreference({ phone, enabled: body.enabled, source: "admin", adminId: admin.adminId })
      : await getReturnReminderPreference({ phone });
    return reply({ enabled: preference.enabled });
  } catch (error) {
    if (error instanceof AdminAuthError) return reply({ error: error.code, message: error.message }, error.status);
    const status = [400, 404].includes(error.status) ? error.status : 500;
    return reply({
      error: status === 500 ? "RETURN_REMINDER_PREFERENCE_UNAVAILABLE" : error.code,
      message: status === 404 ? "الزبون غير موجود." : status === 400 ? "تعذر حفظ الإعداد. تحقق من البيانات وموافقة الزبون." : "تعذر تحميل أو حفظ إعداد التذكير. حاول مرة أخرى.",
    }, status);
  }
}

export const GET = (request, context) => handlePreference(request, context, false);
export const PATCH = (request, context) => handlePreference(request, context, true);
