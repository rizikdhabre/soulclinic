import { NextResponse } from "next/server";
import { AdminAuthError, requireAdmin } from "@/lib/adminAuth";
import { queueTreatmentOrder } from "@/lib/treatmentOrdering";
import { start } from "workflow/api";
import { scheduleTreatmentOrder } from "@/workflows/treatment-order";

export async function PUT(req) {
  try {
    const admin = requireAdmin(req);
    const body = await req.json();
    if (body.owner !== undefined && body.owner !== String(admin.adminId)) throw new AdminAuthError("FORBIDDEN");
    const request = body.clientId === undefined && body.sequence === undefined ? undefined : { clientId: body.clientId, sequence: body.sequence };
    const resourceKey = await queueTreatmentOrder(body.order, { request });
    await start(scheduleTreatmentOrder, [resourceKey]);
    return NextResponse.json({ accepted: true }, { status: 202 });
  } catch (error) {
    const status = error instanceof SyntaxError ? 400 : error.status || 500;
    return NextResponse.json({ message: status < 500 ? error.message : "Failed to save treatment order" }, { status });
  }
}
