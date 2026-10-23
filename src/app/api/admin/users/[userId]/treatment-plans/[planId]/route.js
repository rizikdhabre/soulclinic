import { NextResponse } from "next/server";
import { withAdminRoute } from "@/lib/adminAuth";
import { deleteCanceledTreatmentPlan } from "@/lib/treatmentPlanDeletion";

export const DELETE = withAdminRoute(async function DELETE(request, context) {
  const headers = { "Cache-Control": "private, no-store" };
  try {
    const { userId, planId } = await context.params;
    return NextResponse.json(await deleteCanceledTreatmentPlan({ userId, planId }), { headers });
  } catch (error) {
    const codes = { INVALID_USER_ID: 400, INVALID_PLAN_ID: 400, PLAN_NOT_FOUND: 404, PLAN_NOT_FULLY_CANCELED: 409, TRANSACTIONS_REQUIRED: 503 };
    const status = codes[error.code] || 500;
    const code = status === 500 ? "PLAN_DELETE_FAILED" : error.code;
    const message = status === 409 ? "لا يمكن حذف البرنامج إلا بعد إلغاء جميع مواعيده. حدّث الملف للتحقق من حالته."
      : status === 404 ? "البرنامج غير موجود." : "تعذر حذف البرنامج. حاول مرة أخرى.";
    return NextResponse.json({ error: code, message }, { status, headers });
  }
});
