import { randomUUID } from "node:crypto";
import { after } from "next/server";
import { runDailyReturnReminders } from "@/lib/returnReminderDailyJob";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;
const headers = { "Cache-Control": "private, no-store" };

export async function GET(request) {
  if (!process.env.CRON_SECRET?.trim() || request.headers.get("x-cron-secret") !== process.env.CRON_SECRET) {
    return Response.json({ error: "Unauthorized" }, { status: 401, headers });
  }
  try {
    const dryRun = new URL(request.url).searchParams.get("dryRun") === "1";
    const executionId = randomUUID();
    // cron-job.org closes requests after 30 seconds. Next/Vercel keeps this
    // callback alive after the response, subject to the route's maxDuration.
    after(async () => {
      console.info("return-reminders", { executionId, event: "started", dryRun });
      try {
        const result = await runDailyReturnReminders({ dryRun });
        // Select aggregate fields explicitly; never log customer/provider data.
        console.info("return-reminders", {
          executionId, event: "finished", status: result.status, dryRun,
          eligible: result.eligible, sent: result.sent, failed: result.failed,
          unknown: result.unknown, skipped: result.skipped,
          continuationPending: result.continuationPending,
        });
      } catch {
        console.error("return-reminders", { executionId, event: "failed", dryRun, error: "RETURN_REMINDERS_FAILED" });
      }
    });
    return Response.json({ accepted: true, executionId, returnReminders: { status: "accepted", dryRun } }, { status: 202, headers });
  } catch {
    return Response.json({ success: false, error: "RETURN_REMINDERS_FAILED" }, { status: 500, headers });
  }
}
