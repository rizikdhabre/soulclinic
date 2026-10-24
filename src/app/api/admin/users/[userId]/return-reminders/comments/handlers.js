import { NextResponse } from "next/server";
import { ObjectId } from "mongodb";
import { AdminAuthError, requireAdmin } from "@/lib/adminAuth";
import { normalizeIsraeliPhone } from "@/lib/phone";
import { addReturnReminderComment, deleteReturnReminderComment, getReturnReminderComments, updateReturnReminderComment } from "@/lib/returnReminderComments";

const headers = { "Cache-Control": "private, no-store" };
const reply = (body, status = 200) => NextResponse.json(body, { status, headers });
const failure = (status, code) => Object.assign(new Error(code), { status, code });
const operations = { get: getReturnReminderComments, add: addReturnReminderComment, update: updateReturnReminderComment, remove: deleteReturnReminderComment };

export function commentHandler(operation) {
  return async (request, context) => {
    try {
      requireAdmin(request);
      const { userId, commentId } = await context.params;
      if (typeof userId !== "string" || !/^[a-f\d]{24}$/i.test(userId)) throw failure(400, "INVALID_USER_ID");
      let body;
      if (operation !== "get") {
        try { body = await request.json(); } catch { throw failure(400, "INVALID_JSON"); }
        if (!body || typeof body !== "object" || Array.isArray(body)) throw failure(400, "INVALID_JSON");
      }
      const { getCollection } = await import("@/lib/db");
      const users = await getCollection("usersData");
      const user = await users.findOne({ _id: new ObjectId(userId) }, { projection: { phone: 1 } });
      if (!user) throw failure(404, "USER_NOT_FOUND");
      const phone = typeof user.phone === "string" ? normalizeIsraeliPhone(user.phone) : null;
      if (!phone) throw failure(400, "INVALID_PHONE");
      const input = operation === "get" ? { phone }
        : operation === "add" ? { phone, commentId: body.commentId, text: body.text }
          : { phone, commentId, revision: body.revision, ...(operation === "update" ? { text: body.text } : {}) };
      return reply(await operations[operation](input));
    } catch (error) {
      if (error instanceof AdminAuthError) return reply({ error: error.code, message: error.message }, error.status);
      const status = [400, 404, 409].includes(error.status) ? error.status : 500;
      const code = status === 500 ? "COMMENTS_UNAVAILABLE" : error.code;
      const message = code === "COMMENT_LIMIT_REACHED" ? "يمكن إضافة 100 تعليق للتذكير كحد أقصى."
        : status === 409 ? "تغيّرت التعليقات. حدّث التعليقات وحاول مرة أخرى."
          : status === 404 ? "الزبون أو التعليق غير موجود." : "تعذر تحميل أو حفظ التعليقات. تحقق من البيانات وحاول مرة أخرى.";
      return reply({ error: code, message }, status);
    }
  };
}
