import { NextResponse } from "next/server";
import { AdminAuthError, requireAdmin } from "@/lib/adminAuth";
import { saveServiceOrder } from "@/lib/treatmentOrdering";
import { advanceTreatmentCatalogCacheGeneration } from "@/lib/cache/redisReadCache";

export async function PUT(req) {
  try {
    const admin = requireAdmin(req);
    const body = await req.json();
    if (body.owner !== undefined && body.owner !== String(admin.adminId)) throw new AdminAuthError("FORBIDDEN");
    const request = body.clientId === undefined && body.sequence === undefined ? undefined : { clientId: body.clientId, sequence: body.sequence };
    await saveServiceOrder(body.treatmentId, body.order, { request });
    await advanceTreatmentCatalogCacheGeneration().catch(() => false);

    return NextResponse.json({ message: "Service order saved" });
  } catch (error) {
    const status = error instanceof SyntaxError ? 400 : error.status || 500;
    return NextResponse.json({ message: status < 500 ? error.message : "Failed to save service order" }, { status });
  }
}
