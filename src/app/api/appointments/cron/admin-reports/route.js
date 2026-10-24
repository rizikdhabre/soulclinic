import { randomUUID } from "node:crypto";
import { after } from "next/server";
import { runDailyAdminReports } from "@/lib/adminDailyReports";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;
const headers = { "Cache-Control": "private, no-store" };

function reportSummary(report) {
  return { status: report?.status, count: report?.count, characters: report?.characters };
}

export async function GET(request) {
  if (!process.env.CRON_SECRET?.trim() || request.headers.get("x-cron-secret") !== process.env.CRON_SECRET) {
    return Response.json({ error: "Unauthorized" }, { status: 401, headers });
  }
  try {
    const dryRun = new URL(request.url).searchParams.get("dryRun") === "1";
    const executionId = randomUUID();
    // Return before cron-job.org's connection timeout. Next/Vercel runs this
    // callback after the response, within this route's maxDuration.
    after(async () => {
      console.info("admin-reports", { executionId, event: "started", dryRun });
      try {
        const result = await runDailyAdminReports({ dryRun });
        // Include only aggregate fields, never frozen lists, contacts or errors
        // returned by a provider. The execution ID connects these logs to HTTP202.
        console.info("admin-reports", {
          executionId, event: "finished", status: result.status, dryRun,
          date: result.date, tomorrow: result.tomorrow,
          appointments: reportSummary(result.appointments),
          feedback: reportSummary(result.feedback),
        });
      } catch {
        console.error("admin-reports", { executionId, event: "failed", dryRun, error: "ADMIN_REPORTS_FAILED" });
      }
    });
    return Response.json({ accepted: true, executionId, adminReports: { status: "accepted", dryRun } }, { status: 202, headers });
  } catch {
    return Response.json({ success: false, error: "ADMIN_REPORTS_FAILED" }, { status: 500, headers });
  }
}
