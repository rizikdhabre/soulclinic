import { sendDueFeedbackRequests } from "@/lib/appointmentFeedback";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request) {
  const secret = process.env.CRON_SECRET;
  if (!secret?.trim() || request.headers.get("x-cron-secret") !== secret) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }
  try {
    const dryRun = new URL(request.url).searchParams.get("dryRun") === "1";
    const result = await sendDueFeedbackRequests({ dryRun });
    return Response.json({ success: true, ...result }, { headers: { "Cache-Control": "no-store" } });
  } catch {
    return Response.json({ error: "FEEDBACK_FAILED" }, { status: 500 });
  }
}
