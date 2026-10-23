import { NextResponse } from "next/server";
import { withAdminRoute } from "@/lib/adminAuth";
import { createTreatmentPlan, TreatmentPlanError } from "@/lib/treatmentPlans";
import { getAdminCustomerPlans } from "@/lib/adminCustomerProfile";

export const GET = withAdminRoute(async function GET(request, context) {
  const headers = { "Cache-Control": "private, no-store" };
  try {
    const { userId } = await context.params;
    const cursor = new URL(request.url).searchParams.get("cursor");
    return NextResponse.json(await getAdminCustomerPlans(userId, { cursor }), { headers });
  } catch (error) {
    const status = [400, 404].includes(error.status) ? error.status : 500;
    const code = status === 404 ? "USER_NOT_FOUND" : status === 400 ? (error.code === "INVALID_USER_ID" ? "INVALID_USER_ID" : "INVALID_CURSOR") : "PLANS_UNAVAILABLE";
    const message = status === 404 ? "الزبون غير موجود." : status === 400 ? "تعذر تحديد صفحة البرامج. حدّث ملف الزبون وحاول مرة أخرى." : "تعذر تحميل المزيد من البرامج. حاول مرة أخرى.";
    return NextResponse.json({ error: code, message }, { status, headers });
  }
});

async function postTreatmentPlan(request, context) {
  let body;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "INVALID_JSON", message: "A valid JSON request body is required." }, { status: 400 });
  }
  try {
    const { userId } = await context.params;
    const result = await createTreatmentPlan({ userId, requestId: body?.requestId, appointments: body?.appointments });
    return NextResponse.json(result);
  } catch (error) {
    if (error instanceof TreatmentPlanError) {
      return NextResponse.json({
        error: error.code, message: error.message,
        ...(error.rowIndex !== undefined ? { rowIndex: error.rowIndex } : {}),
      }, { status: error.status });
    }
    return NextResponse.json({
      error: "TREATMENT_PLAN_FAILED",
      message: "The treatment plan could not be saved. Retry this same request ID.",
    }, { status: 500 });
  }
}

export const POST = withAdminRoute(postTreatmentPlan);
