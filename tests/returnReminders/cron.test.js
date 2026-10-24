import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const external = vi.hoisted(() => ({
  getCollection: vi.fn(), sendWhatsAppTemplate: vi.fn(),
  sendDueFeedbackRequests: vi.fn(), sendDueReturnReminders: vi.fn(),
}));
vi.mock("@/lib/db", () => ({ getCollection: external.getCollection }));
vi.mock("@/lib/whatsapp", () => ({ sendWhatsAppTemplate: external.sendWhatsAppTemplate }));
vi.mock("@/lib/appointmentFeedback", () => ({ sendDueFeedbackRequests: external.sendDueFeedbackRequests }));
vi.mock("@/lib/returnReminders", () => ({ sendDueReturnReminders: external.sendDueReturnReminders }));

import { GET } from "@/app/api/appointments/cron/reminder/route";

const request = (query = "", secret = "secret") => new Request(`https://clinic.example/api/appointments/cron/reminder${query}`, {
  headers: secret ? { "x-cron-secret": secret } : {},
});

beforeEach(() => {
  vi.stubEnv("CRON_SECRET", "secret");
  vi.stubEnv("RETURN_REMINDERS_ENABLED", "true");
  vi.stubEnv("FEEDBACK_REQUESTS_ENABLED", "false");
  external.getCollection.mockResolvedValue({ findOne: vi.fn(async () => null) });
  external.sendDueReturnReminders.mockResolvedValue({ status: "completed", sent: 1 });
  external.sendDueFeedbackRequests.mockResolvedValue({ status: "completed", sent: 2 });
});
afterEach(() => vi.unstubAllEnvs());

describe("appointment and feedback cron after separating return reminders", () => {
  it("never scans return reminders from the ten-minute endpoint", async () => {
    const response = await GET(request());
    expect(response.status).toBe(200);
    expect(await response.json()).not.toHaveProperty("returnReminders");
    expect(external.sendDueReturnReminders).not.toHaveBeenCalled();
  });

  it("passes dry-run intent but never sends a simulated clock to the new job", async () => {
    const response = await GET(request("?dryRun=1&testTime=2040-01-01T00:00:00Z"));
    expect(response.status).toBe(200);
    expect(external.sendDueReturnReminders).not.toHaveBeenCalled();
  });

  it("ignores the legacy test clock for actual monthly sends", async () => {
    await GET(request("?testTime=2040-01-01T00:00:00Z"));
    expect(external.sendDueReturnReminders).not.toHaveBeenCalled();
  });

  it.each(["", "   "])("requires a configured nonblank cron secret when enabled (%j)", async secret => {
    vi.stubEnv("CRON_SECRET", secret);
    const response = await GET(request("", ""));
    expect(response.status).toBe(401);
    expect(external.getCollection).not.toHaveBeenCalled();
    expect(external.sendDueReturnReminders).not.toHaveBeenCalled();
  });

  it.each(["", "incorrect"])("rejects missing or incorrect caller secrets (%j)", async secret => {
    const response = await GET(request("", secret));
    expect(response.status).toBe(401);
    expect(external.sendDueReturnReminders).not.toHaveBeenCalled();
  });

  it("leaves the new job inactive when its flag is off", async () => {
    vi.stubEnv("RETURN_REMINDERS_ENABLED", "false");
    vi.stubEnv("CRON_SECRET", "");
    const response = await GET(request("", ""));
    expect(response.status).toBe(200);
    expect(await response.json()).not.toHaveProperty("returnReminders");
    expect(external.sendDueReturnReminders).not.toHaveBeenCalled();
  });

  it("reports a feedback failure without running unrelated return reminders", async () => {
    vi.stubEnv("FEEDBACK_REQUESTS_ENABLED", "true");
    external.sendDueFeedbackRequests.mockRejectedValueOnce(new Error("private feedback provider details"));
    const response = await GET(request());
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ feedback: { status: "failed" } });
    expect(external.sendDueReturnReminders).not.toHaveBeenCalled();
  });

  it("retains weekly feedback processing", async () => {
    vi.stubEnv("FEEDBACK_REQUESTS_ENABLED", "true");
    external.sendDueReturnReminders.mockRejectedValueOnce(new Error("private monthly provider details"));
    const response = await GET(request());
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toMatchObject({ feedback: { status: "completed", sent: 2 } });
    expect(body).not.toHaveProperty("returnReminders");
    expect(external.sendDueReturnReminders).not.toHaveBeenCalled();
    expect(JSON.stringify(body)).not.toContain("private monthly");
  });
});
