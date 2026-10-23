import { NextResponse } from "next/server";
import { withAdminRoute } from "@/lib/adminAuth";
import { createTreatmentPlan, TreatmentPlanError } from "@/lib/treatmentPlans";

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
