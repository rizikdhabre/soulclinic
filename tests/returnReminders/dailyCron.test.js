import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const external = vi.hoisted(() => ({ run: vi.fn(), after: vi.fn(), callbacks: [] }));
vi.mock("@/lib/returnReminderDailyJob", () => ({ runDailyReturnReminders: external.run }));
vi.mock("next/server", () => ({ after: external.after }));
import { GET } from "@/app/api/appointments/cron/return-reminders/route";

beforeEach(() => {
  vi.stubEnv("CRON_SECRET", "isolated-secret");
  external.callbacks.length = 0;
  external.after.mockReset().mockImplementation(callback => external.callbacks.push(callback));
  external.run.mockReset().mockResolvedValue({ status: "completed", dryRun: false, eligible: 2, sent: 2, failed: 0, unknown: 0, skipped: 0, continuationPending: false });
  vi.spyOn(console, "info").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => vi.unstubAllEnvs());
const request = (query = "", secret = "isolated-secret") => new Request(`https://clinic.example/api/appointments/cron/return-reminders${query}`, {
  headers: { "x-cron-secret": secret },
});

describe("dedicated daily return cron", () => {
  it.each(["", "wrong"])("rejects an unauthorized caller (%j)", async secret => {
    expect((await GET(request("", secret))).status).toBe(401);
    expect(external.run).not.toHaveBeenCalled();
    expect(external.callbacks).toHaveLength(0);
  });
  it("requires a configured secret even when caller has a blank one", async () => {
    vi.stubEnv("CRON_SECRET", " ");
    expect((await GET(request("", " "))).status).toBe(401);
    expect(external.run).not.toHaveBeenCalled();
    expect(external.callbacks).toHaveLength(0);
  });
  it("acknowledges before a slow worker starts instead of holding the cron connection", async () => {
    let release;
    const slow = new Promise(resolve => { release = resolve; });
    external.run.mockReturnValueOnce(slow);
    let timeout;
    const responsePromise = GET(request());
    try {
      const response = await Promise.race([
        responsePromise,
        new Promise(resolve => { timeout = setTimeout(() => resolve(null), 100); }),
      ]);
      expect(response, "HTTP response must not wait for reminder processing").not.toBeNull();
      expect(response.status).toBe(202);
      expect(external.run).not.toHaveBeenCalled();
      expect(external.callbacks).toHaveLength(1);
      const body = await response.json();
      expect(body).toEqual({ accepted: true, executionId: expect.any(String), returnReminders: { status: "accepted", dryRun: false } });
      expect(body.executionId).toMatch(/^[a-f\d-]{36}$/);
      release({ status: "completed", sent: 0 });
      await external.callbacks[0]();
      expect(external.run).toHaveBeenCalledExactlyOnceWith({ dryRun: false });
    } finally {
      clearTimeout(timeout);
      release({ status: "completed", sent: 0 });
      await responsePromise;
    }
  });
  it("uses the real clock and does not expose a pretend completed result", async () => {
    const response = await GET(request("?testTime=2040-01-01T00:00:00Z"));
    const body = await response.json();
    expect(body).toMatchObject({ accepted: true, returnReminders: { status: "accepted", dryRun: false } });
    expect(body.returnReminders).not.toHaveProperty("sent");
    await external.callbacks[0]();
    expect(external.run).toHaveBeenCalledExactlyOnceWith({ dryRun: false });
    expect(response.headers.get("cache-control")).toContain("no-store");
  });
  it("also runs a read-only eligibility check after responding", async () => {
    const response = await GET(request("?dryRun=1"));
    expect(response.status).toBe(202);
    expect(await response.json()).toMatchObject({ returnReminders: { status: "accepted", dryRun: true } });
    expect(external.run).not.toHaveBeenCalled();
    await external.callbacks[0]();
    expect(external.run).toHaveBeenCalledExactlyOnceWith({ dryRun: true });
  });
  it("logs background failure without leaking provider/customer data or rejecting the callback", async () => {
    external.run.mockRejectedValueOnce(new Error("secret private details"));
    const response = await GET(request());
    const { executionId } = await response.json();
    await expect(external.callbacks[0]()).resolves.toBeUndefined();
    expect(console.error).toHaveBeenCalledExactlyOnceWith("return-reminders", {
      executionId, event: "failed", dryRun: false, error: "RETURN_REMINDERS_FAILED",
    });
    expect(JSON.stringify(console.error.mock.calls)).not.toContain("secret private details");
  });
  it.each(["completed", "partial", "disabled", "busy"])("logs a safe correlated %s result", async status => {
    external.run.mockResolvedValueOnce({ status, dryRun: false, eligible: 60, sent: 59, failed: 1, unknown: 0, skipped: 0,
      continuationPending: status === "partial", phone: "private-phone", providerError: "private-error", token: "private-token" });
    const { executionId } = await (await GET(request())).json();
    await external.callbacks[0]();
    expect(console.info).toHaveBeenCalledWith("return-reminders", { executionId, event: "started", dryRun: false });
    expect(console.info).toHaveBeenLastCalledWith("return-reminders", {
      executionId, event: "finished", status, dryRun: false, eligible: 60, sent: 59, failed: 1, unknown: 0, skipped: 0, continuationPending: status === "partial",
    });
    expect(JSON.stringify(console.info.mock.calls)).not.toContain("private-");
  });
  it("assigns different execution IDs to repeated triggers", async () => {
    const first = await (await GET(request())).json();
    const second = await (await GET(request())).json();
    expect(first.executionId).not.toBe(second.executionId);
  });
  it("returns a sanitized failure if background registration itself fails", async () => {
    external.after.mockImplementationOnce(() => { throw new Error("private runtime details"); });
    const response = await GET(request());
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ success: false, error: "RETURN_REMINDERS_FAILED" });
    expect(external.run).not.toHaveBeenCalled();
    expect(external.callbacks).toHaveLength(0);
  });
});
