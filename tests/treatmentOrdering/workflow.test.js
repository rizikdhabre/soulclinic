import { afterEach, beforeEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ process: vi.fn(), invalidate: vi.fn() }));
vi.mock("@/lib/treatmentOrdering", () => ({ processPendingTreatmentOrder: mocks.process }));
vi.mock("@/lib/cache/redisReadCache", () => ({ advanceTreatmentCatalogCacheGeneration: mocks.invalidate }));
vi.mock("workflow", () => ({
  sleep: milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds)),
  RetryableError: class extends Error {},
  FatalError: class extends Error {},
}));
const { scheduleTreatmentOrder } = await import("@/workflows/treatment-order");

beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(new Date("2026-11-08T10:00:00Z")); mocks.process.mockReset(); mocks.invalidate.mockReset().mockResolvedValue(true); });
afterEach(() => vi.useRealTimers());

it("runs the server job after its deadline without any browser connection", async () => {
  mocks.process.mockResolvedValueOnce({ status: "waiting", dueAt: new Date(Date.now() + 5000).toISOString() }).mockResolvedValueOnce({ status: "applied" });
  const job = scheduleTreatmentOrder("main");
  await vi.advanceTimersByTimeAsync(4999);
  expect(mocks.process).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(1);
  await job;
  expect(mocks.process).toHaveBeenCalledTimes(2);
  expect(mocks.invalidate).toHaveBeenCalledTimes(1);
});

it("keeps waiting when a newer drag extends the server deadline", async () => {
  const now = Date.now();
  mocks.process.mockResolvedValueOnce({ status: "waiting", dueAt: new Date(now + 5000).toISOString() })
    .mockResolvedValueOnce({ status: "waiting", dueAt: new Date(now + 8000).toISOString() })
    .mockResolvedValueOnce({ status: "applied" });
  const job = scheduleTreatmentOrder("main");
  await vi.advanceTimersByTimeAsync(7999);
  expect(mocks.invalidate).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(1);
  await job;
  expect(mocks.invalidate).toHaveBeenCalledTimes(1);
});
