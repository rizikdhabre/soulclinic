import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const worker = vi.hoisted(() => ({ run: vi.fn(), after: vi.fn(), callbacks: [] }));
vi.mock("@/lib/adminDailyReports", () => ({ runDailyAdminReports: worker.run }));
vi.mock("next/server", () => ({ after: worker.after }));
import { GET, maxDuration, runtime, dynamic } from "@/app/api/appointments/cron/admin-reports/route";

const request = (query = "", secret = "isolated-secret") => new Request(`https://clinic.example/api/appointments/cron/admin-reports${query}`, {
  headers: secret === null ? {} : { "x-cron-secret": secret },
});
const summary = {
  status: "completed", dryRun: false, date: "2026-10-25", tomorrow: "2026-10-26",
  appointments: { status: "sent", count: 3, characters: 250 },
  feedback: { status: "sent", count: 2, characters: 350 },
};

beforeEach(() => {
  vi.stubEnv("CRON_SECRET", "isolated-secret");
  worker.callbacks.length = 0;
  worker.after.mockReset().mockImplementation(callback => worker.callbacks.push(callback));
  worker.run.mockReset().mockResolvedValue(summary);
  vi.spyOn(console, "info").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => vi.unstubAllEnvs());

describe("admin reports cron endpoint", () => {
  it.each([null, "", "wrong"])("rejects missing or wrong authorization (%j) without scheduling work", async secret => {
    const response = await GET(request("", secret));
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: "Unauthorized" });
    expect(response.headers.get("cache-control")).toContain("no-store");
    expect(worker.callbacks).toHaveLength(0);
    expect(worker.run).not.toHaveBeenCalled();
  });

  it.each([undefined, "", "   "])("requires a nonblank configured secret (%j)", async secret => {
    vi.stubEnv("CRON_SECRET", secret);
    expect((await GET(request("", ""))).status).toBe(401);
    expect(worker.callbacks).toHaveLength(0);
  });

  it("does not normalize a configured secret into a different accepted value", async () => {
    vi.stubEnv("CRON_SECRET", " isolated-secret ");
    expect((await GET(request())).status).toBe(401);
    expect(worker.callbacks).toHaveLength(0);
  });

  it("acknowledges promptly without waiting for worker execution", async () => {
    let release;
    worker.run.mockReturnValueOnce(new Promise(resolve => { release = resolve; }));
    let timeout;
    const responsePromise = GET(request());
    try {
      const response = await Promise.race([
        responsePromise,
        new Promise(resolve => { timeout = setTimeout(() => resolve(null), 100); }),
      ]);
      expect(response, "the cron connection must not wait for WhatsApp processing").not.toBeNull();
      expect(response.status).toBe(202);
      expect(response.headers.get("cache-control")).toContain("no-store");
      const body = await response.json();
      expect(body).toEqual({ accepted: true, executionId: expect.any(String), adminReports: { status: "accepted", dryRun: false } });
      expect(body.executionId).toMatch(/^[a-f\d-]{36}$/);
      expect(worker.callbacks).toHaveLength(1);
      expect(worker.run).not.toHaveBeenCalled();
      release(summary);
      await worker.callbacks[0]();
      expect(worker.run).toHaveBeenCalledExactlyOnceWith({ dryRun: false });
    } finally {
      clearTimeout(timeout);
      release(summary);
      await responsePromise;
    }
  });

  it("uses a Node background lifetime independent of the scheduler's 30 second connection", () => {
    expect(runtime).toBe("nodejs");
    expect(dynamic).toBe("force-dynamic");
    expect(maxDuration).toBe(300);
  });

  it("does not allow query parameters to override the real clock, date or duplicate protection", async () => {
    const response = await GET(request("?testTime=2040-01-01T00:00:00Z&now=2040-01-01&date=2040-01-01&force=1"));
    const body = await response.json();
    expect(body.adminReports).toEqual({ status: "accepted", dryRun: false });
    expect(body).not.toHaveProperty("success");
    expect(body.adminReports).not.toHaveProperty("sent");
    await worker.callbacks[0]();
    expect(worker.run).toHaveBeenCalledExactlyOnceWith({ dryRun: false });
  });

  it.each([["1", true], ["0", false], ["true", false], ["", false]])("enables read-only worker mode only for dryRun=1 (%j)", async (value, dryRun) => {
    const response = await GET(request(`?dryRun=${value}`));
    expect(response.status).toBe(202);
    expect(await response.json()).toMatchObject({ adminReports: { status: "accepted", dryRun } });
    expect(worker.run).not.toHaveBeenCalled();
    await worker.callbacks[0]();
    expect(worker.run).toHaveBeenCalledExactlyOnceWith({ dryRun });
  });

  it.each(["completed", "partial", "not_due", "not_configured"])("logs only safe correlated %s results", async status => {
    worker.run.mockResolvedValueOnce({
      ...summary, status, recipient: "private-phone", providerError: "private-provider-error", payload: "private-body",
      appointments: { ...summary.appointments, rows: ["private-appointments"], text: "private-list", sid: "private-sid" },
      feedback: { ...summary.feedback, rows: ["private-feedback"], text: "private-feedback-list" },
    });
    const { executionId } = await (await GET(request())).json();
    await worker.callbacks[0]();
    expect(console.info).toHaveBeenCalledWith("admin-reports", { executionId, event: "started", dryRun: false });
    expect(console.info).toHaveBeenLastCalledWith("admin-reports", {
      executionId, event: "finished", status, dryRun: false,
      date: summary.date, tomorrow: summary.tomorrow,
      appointments: summary.appointments, feedback: summary.feedback,
    });
    expect(JSON.stringify(console.info.mock.calls)).not.toContain("private-");
  });

  it("sanitizes background exceptions without rejecting the scheduled callback", async () => {
    worker.run.mockRejectedValueOnce(new Error("private customer name and provider credentials"));
    const { executionId } = await (await GET(request())).json();
    await expect(worker.callbacks[0]()).resolves.toBeUndefined();
    expect(console.error).toHaveBeenCalledExactlyOnceWith("admin-reports", {
      executionId, event: "failed", dryRun: false, error: "ADMIN_REPORTS_FAILED",
    });
    expect(JSON.stringify(console.error.mock.calls)).not.toContain("private");
  });

  it("assigns a distinct correlation ID to each invocation", async () => {
    const first = await (await GET(request())).json();
    const second = await (await GET(request())).json();
    expect(first.executionId).not.toBe(second.executionId);
  });

  it("reports background registration failure without leaking runtime details", async () => {
    worker.after.mockImplementationOnce(() => { throw new Error("private runtime details"); });
    const response = await GET(request());
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ success: false, error: "ADMIN_REPORTS_FAILED" });
    expect(response.headers.get("cache-control")).toContain("no-store");
    expect(worker.callbacks).toHaveLength(0);
    expect(worker.run).not.toHaveBeenCalled();
  });
});
