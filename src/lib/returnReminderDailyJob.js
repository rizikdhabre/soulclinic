import { randomUUID } from "node:crypto";
import { sendDueReturnReminders } from "@/lib/returnReminders";

const BUDGET_MS = 240_000;
const LEASE_MS = 300_000;
const WRITE = { writeConcern: { w: "majority", wtimeoutMS: 10_000 } };
const counts = ["eligible", "sent", "failed", "unknown", "skipped"];

/** One scheduled invocation drains batches until done or a safe time boundary. */
export async function runDailyReturnReminders({ now = new Date(), dryRun = false } = {}, deps = {}) {
  const result = { status: "completed", dryRun: Boolean(dryRun), eligible: 0, sent: 0, failed: 0, unknown: 0, skipped: 0, continuationPending: false };
  const env = deps.env || process.env;
  if (env.RETURN_REMINDERS_ENABLED !== "true") return { ...result, status: "disabled" };
  const clock = deps.clock || { now: () => new Date() };
  const startedAt = clock.now().getTime();
  const currentTime = () => new Date(now.getTime() + Math.max(0, clock.now().getTime() - startedAt));
  const shouldStop = () => clock.now().getTime() - startedAt >= BUDGET_MS;
  const seenPhones = new Set();
  let jobs, owner, cursor = null, initialCursor = null, throughId = null;
  if (!dryRun) {
    const getCollection = deps.getCollection || (await import("@/lib/db")).getCollection;
    jobs = await getCollection("returnReminderJobs");
    owner = randomUUID();
    try {
      const claim = await jobs.findOneAndUpdate({ _id: "daily", leaseUntil: { $lte: now } }, {
        $set: { owner, leaseUntil: new Date(now.getTime() + LEASE_MS), startedAt: now },
      }, { upsert: true, returnDocument: "after", ...WRITE });
      if (!claim || claim.owner !== owner) return { ...result, status: "busy" };
      cursor = claim.cursor ?? null;
      initialCursor = cursor;
    } catch (error) {
      if (error.code === 11000) return { ...result, status: "busy" };
      throw error;
    }
  }
  try {
    while (true) {
      if (shouldStop()) { result.status = "partial"; break; }
      const batch = await sendDueReturnReminders({ now: currentTime(), dryRun, afterId: cursor, throughId, scanProgress: true }, { ...deps, shouldStop, seenPhones });
      for (const name of counts) result[name] += batch[name];
      if (batch.status !== "completed") { result.status = batch.status; break; }
      cursor = batch.scan.cursor;
      let finished = !batch.scan.hasMore;
      // After resuming a partial tail, check the earlier customers in this same
      // invocation as well. They may have become due since the last daily run.
      if (finished && initialCursor && !throughId) {
        throughId = initialCursor;
        cursor = null;
        finished = false;
      }
      if (jobs) {
        const saved = await jobs.updateOne({ _id: "daily", owner }, {
          $set: { cursor: finished ? null : cursor, checkpointAt: currentTime() },
        }, WRITE);
        if (saved.matchedCount !== 1) { result.status = "partial"; break; }
      }
      if (finished) break;
    }
    result.continuationPending = result.status === "partial";
    return result;
  } finally {
    if (jobs) await jobs.updateOne({ _id: "daily", owner }, { $set: { leaseUntil: currentTime(), finishedAt: currentTime() } }, WRITE);
  }
}
