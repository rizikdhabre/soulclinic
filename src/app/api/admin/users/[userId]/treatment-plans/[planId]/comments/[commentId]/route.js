import { NextResponse } from "next/server";
import { withAdminRoute } from "@/lib/adminAuth";
import { deleteTreatmentPlanComment, updateTreatmentPlanComment } from "@/lib/treatmentPlanComments";

const errorCodes = {
  INVALID_USER_ID: 400, INVALID_PLAN_ID: 400, INVALID_COMMENT_ID: 400, INVALID_COMMENT_TEXT: 400, INVALID_COMMENT_REVISION: 400, INVALID_JSON: 400,
  PLAN_NOT_FOUND: 404, COMMENT_NOT_FOUND: 404, COMMENT_CONFLICT: 409, COMMENT_ID_REUSED: 409, COMMENT_LIMIT_REACHED: 409,
};

function handler(remove) {
  const authorized = withAdminRoute(async (request, context) => {
    try {
      const { userId, planId, commentId } = await context.params;
      let body;
      try { body = await request.json(); } catch { throw Object.assign(new Error("INVALID_JSON"), { code: "INVALID_JSON" }); }
      const input = { userId, planId, commentId, revision: body?.revision };
      const result = remove ? await deleteTreatmentPlanComment(input) : await updateTreatmentPlanComment({ ...input, text: body?.text });
      return NextResponse.json(result);
    } catch (error) {
      const status = errorCodes[error.code] || 500;
      const code = status === 500 ? "COMMENTS_UNAVAILABLE" : error.code;
      const message = status === 409 ? "تغيّر التعليق. حدّث التعليقات وحاول مرة أخرى."
        : status === 404 ? "البرنامج أو التعليق غير موجود." : "تعذر تعديل أو حذف التعليق. تحقق من البيانات وحاول مرة أخرى.";
      return NextResponse.json({ error: code, message }, { status });
    }
  });
  return async (...args) => {
    const response = await authorized(...args);
    response.headers.set("Cache-Control", "private, no-store");
    return response;
  };
}

export const PATCH = handler(false);
export const DELETE = handler(true);
