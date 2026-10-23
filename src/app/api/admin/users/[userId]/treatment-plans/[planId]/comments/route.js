import { NextResponse } from "next/server";
import { withAdminRoute } from "@/lib/adminAuth";
import { addTreatmentPlanComment, getTreatmentPlanComments } from "@/lib/treatmentPlanComments";

const errorCodes = {
  INVALID_USER_ID: 400, INVALID_PLAN_ID: 400, INVALID_COMMENT_ID: 400, INVALID_COMMENT_TEXT: 400, INVALID_JSON: 400,
  PLAN_NOT_FOUND: 404, COMMENT_CONFLICT: 409, COMMENT_ID_REUSED: 409, COMMENT_LIMIT_REACHED: 409,
};

function handler(add) {
  const authorized = withAdminRoute(async (request, context) => {
    try {
      const { userId, planId } = await context.params;
      let body;
      if (add) {
        try { body = await request.json(); } catch { throw Object.assign(new Error("INVALID_JSON"), { code: "INVALID_JSON" }); }
      }
      const result = add ? await addTreatmentPlanComment({ userId, planId, commentId: body?.commentId, text: body?.text })
        : await getTreatmentPlanComments({ userId, planId });
      return NextResponse.json(result);
    } catch (error) {
      const status = errorCodes[error.code] || 500;
      const code = status === 500 ? "COMMENTS_UNAVAILABLE" : error.code;
      const message = code === "COMMENT_LIMIT_REACHED" ? "يمكن إضافة 100 تعليق للبرنامج كحد أقصى."
        : status === 409 ? "تغيّرت التعليقات. حدّث التعليقات وحاول مرة أخرى."
          : status === 404 ? "البرنامج غير موجود." : "تعذر تحميل أو حفظ التعليقات. تحقق من البيانات وحاول مرة أخرى.";
      return NextResponse.json({ error: code, message }, { status });
    }
  });
  return async (...args) => {
    const response = await authorized(...args);
    response.headers.set("Cache-Control", "private, no-store");
    return response;
  };
}

export const GET = handler(false);
export const POST = handler(true);
