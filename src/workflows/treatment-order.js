import { sleep, RetryableError, FatalError } from "workflow";
import { processPendingTreatmentOrder } from "@/lib/treatmentOrdering";
import { advanceTreatmentCatalogCacheGeneration } from "@/lib/cache/redisReadCache";

async function processOrder(resourceKey) {
  "use step";
  try {
    const result = await processPendingTreatmentOrder(resourceKey);
    if (result.status === "applied") await advanceTreatmentCatalogCacheGeneration().catch(() => false);
    return result;
  } catch (error) {
    if (error.status >= 400 && error.status < 500 && error.status !== 409) {
      throw new FatalError("Invalid treatment ordering job");
    }
    throw new RetryableError("Treatment ordering temporarily unavailable", { retryAfter: "30s" });
  }
}
processOrder.maxRetries = 20;

export async function scheduleTreatmentOrder(resourceKey) {
  "use workflow";
  while (true) {
    const result = await processOrder(resourceKey);
    if (result.status !== "waiting") return result;
    const remaining = Date.parse(result.dueAt) - Date.now();
    if (remaining > 0) await sleep(remaining);
  }
}
