import { beforeEach, describe, expect, it, vi } from "vitest";

const external = vi.hoisted(() => ({
  getFeedbackRequest: vi.fn(), submitAppointmentFeedback: vi.fn(), sendDueFeedbackRequests: vi.fn(),
  getCollection: vi.fn(), sendWhatsAppTemplate: vi.fn(),
}));
vi.mock("@/lib/appointmentFeedback", () => ({
  getFeedbackRequest: external.getFeedbackRequest,
  submitAppointmentFeedback: external.submitAppointmentFeedback,
  sendDueFeedbackRequests: external.sendDueFeedbackRequests,
}));
vi.mock("@/lib/db", () => ({ getCollection: external.getCollection }));
vi.mock("@/lib/whatsapp", () => ({ sendWhatsAppTemplate: external.sendWhatsAppTemplate }));

import { GET as feedbackGet, POST as feedbackPost } from "@/app/api/feedback/[token]/route";
import { GET as feedbackCron } from "@/app/api/appointments/cron/feedback/route";
import { GET as reminderCron } from "@/app/api/appointments/cron/reminder/route";

const TOKEN = "a".repeat(43);
const context = { params: Promise.resolve({ token: TOKEN }) };
const request = (path = "", options = {}) => new Request(`https://clinic.example${path}`, options);

beforeEach(() => {
  vi.unstubAllEnvs();
  vi.stubEnv("CRON_SECRET", "");
  vi.stubEnv("FEEDBACK_REQUESTS_ENABLED", "false");
  external.getCollection.mockResolvedValue({ findOne: vi.fn(async () => null) });
  external.sendDueFeedbackRequests.mockResolvedValue({ status: "completed", sent: 0 });
});

describe("private feedback HTTP boundary", () => {
  it("keeps successful reads out of caches, indexing, and referrers", async () => {
    external.getFeedbackRequest.mockResolvedValue({ appointment: { title: "test", date: "2026-10-01", time: "12:00" }, submitted: false });
    const result = await feedbackGet(request(`/api/feedback/${TOKEN}`), context);
    expect(result.status).toBe(200);
    expect(result.headers.get("cache-control")).toContain("no-store");
    expect(result.headers.get("referrer-policy")).toBe("no-referrer");
    expect(result.headers.get("x-robots-tag")).toContain("noindex");
    expect(external.getFeedbackRequest).toHaveBeenCalledWith({ token: TOKEN });
  });

  it("accepts only text and never forwards caller-supplied appointment or user identifiers", async () => {
    external.submitAppointmentFeedback.mockResolvedValue({ success: true });
    const result = await feedbackPost(request(`/api/feedback/${TOKEN}`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "feedback", userId: "other", appointmentId: "other" }),
    }), context);
    expect(result.status).toBe(200);
    expect(external.submitAppointmentFeedback).toHaveBeenCalledWith({ token: TOKEN, text: "feedback" });
  });

  it("rejects malformed and oversized bodies before submitting", async () => {
    for (const body of ["{broken", "null", JSON.stringify({ text: "x".repeat(10_001) })]) {
      const result = await feedbackPost(request("/api/feedback/token", { method: "POST", body }), context);
      expect(result.status).toBe(400);
    }
    expect(external.submitAppointmentFeedback).not.toHaveBeenCalled();
  });

  it("returns stable error codes without exposing internal exception text or tokens", async () => {
    external.getFeedbackRequest.mockRejectedValue(Object.assign(new Error(`database details ${TOKEN}`), { status: 404, code: "FEEDBACK_UNAVAILABLE" }));
    const unavailable = await feedbackGet(request("/"), context);
    expect(unavailable.status).toBe(404);
    expect(await unavailable.json()).toEqual({ error: "FEEDBACK_UNAVAILABLE" });
    external.getFeedbackRequest.mockRejectedValue(new Error(`sensitive ${TOKEN}`));
    const failed = await feedbackGet(request("/"), context);
    expect(failed.status).toBe(500);
    expect(await failed.json()).toEqual({ error: "FEEDBACK_FAILED" });
  });
});

describe("cron authorization and existing reminder integration", () => {
  it("new cron fails closed when its secret is absent or incorrect", async () => {
    expect((await feedbackCron(request("/"))).status).toBe(401);
    vi.stubEnv("CRON_SECRET", "secret");
    expect((await feedbackCron(request("/", { headers: { "x-cron-secret": "wrong" } }))).status).toBe(401);
    expect(external.sendDueFeedbackRequests).not.toHaveBeenCalled();
  });

  it("ignores testTime for new-cron real sends and passes authenticated dry-run intent", async () => {
    vi.stubEnv("CRON_SECRET", "secret");
    const result = await feedbackCron(request("/?testTime=2040-01-01T00:00:00Z&dryRun=1", { headers: { "x-cron-secret": "secret" } }));
    expect(result.status).toBe(200);
    expect(external.sendDueFeedbackRequests).toHaveBeenCalledWith({ dryRun: true });
  });

  it("existing reminder still processes disabled feedback with its original optional-secret behavior", async () => {
    const result = await reminderCron(request("/"));
    expect(result.status).toBe(200);
    expect(external.getCollection).toHaveBeenCalledWith("appointments");
    expect(external.sendDueFeedbackRequests).not.toHaveBeenCalled();
  });

  it("existing reminder fails closed when feedback is enabled but the cron secret is missing", async () => {
    vi.stubEnv("FEEDBACK_REQUESTS_ENABLED", "true");
    expect((await reminderCron(request("/"))).status).toBe(401);
    expect(external.getCollection).not.toHaveBeenCalled();
    expect(external.sendDueFeedbackRequests).not.toHaveBeenCalled();
  });

  it("runs due feedback even when there are no reminders today and ignores testTime for real feedback sends", async () => {
    vi.stubEnv("FEEDBACK_REQUESTS_ENABLED", "true");
    vi.stubEnv("CRON_SECRET", "secret");
    const result = await reminderCron(request("/?testTime=2040-01-01T00:00:00Z", { headers: { "x-cron-secret": "secret" } }));
    expect(result.status).toBe(200);
    expect(external.sendDueFeedbackRequests).toHaveBeenCalledWith({ dryRun: false });
    expect((await result.json()).feedback).toEqual({ status: "completed", sent: 0 });
  });
});
