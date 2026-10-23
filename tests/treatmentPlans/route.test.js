import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ verifyToken: vi.fn(), createTreatmentPlan: vi.fn(), listPlans: vi.fn() }));
vi.mock("@/lib/jwt", () => ({ verifyToken: mocks.verifyToken }));
vi.mock("@/lib/adminCustomerProfile", () => ({ getAdminCustomerPlans: mocks.listPlans }));
vi.mock("@/lib/treatmentPlans", () => ({
  createTreatmentPlan: mocks.createTreatmentPlan,
  TreatmentPlanError: class TreatmentPlanError extends Error {
    constructor(code, message, status, rowIndex) { super(message); Object.assign(this, { code, status, rowIndex }); }
  },
}));
import { POST } from "@/app/api/admin/users/[userId]/treatment-plans/route";
import * as route from "@/app/api/admin/users/[userId]/treatment-plans/route";
import { TreatmentPlanError } from "@/lib/treatmentPlans";

function request(cookie = "admin-token", body = {}) {
  return { url: "https://clinic.example/api/admin/users/customer/treatment-plans", cookies: { get: () => cookie ? { value: cookie } : undefined }, json: vi.fn().mockResolvedValue(body) };
}
const context = { params: Promise.resolve({ userId: "000000000000000000000001" }) };

beforeEach(() => { mocks.verifyToken.mockReset(); mocks.createTreatmentPlan.mockReset(); mocks.listPlans.mockReset(); mocks.verifyToken.mockReturnValue({ role: "admin" }); });

describe("treatment plan admin HTTP boundary", () => {
  it.each([[null, null, 401], ["invalid", null, 401], ["customer-token", { role: "customer" }, 403]])("rejects cookie %s before reading input or doing booking work", async (cookie, identity, status) => {
    mocks.verifyToken.mockReturnValue(identity);
    const req = request(cookie);
    const response = await POST(req, context);
    expect(response.status).toBe(status);
    expect(req.json).not.toHaveBeenCalled();
    expect(mocks.createTreatmentPlan).not.toHaveBeenCalled();
  });

  it("uses the route customer ID and returns booking/notification outcome", async () => {
    const result = { success: true, planId: "plan", appointmentIds: ["appointment"], notification: { status: "not_configured" } };
    mocks.createTreatmentPlan.mockResolvedValue(result);
    const response = await POST(request("admin-token", { userId: "spoofed-customer", requestId: "request", appointments: [{ date: "2026-11-01" }] }), context);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(result);
    expect(mocks.createTreatmentPlan).toHaveBeenCalledExactlyOnceWith({ userId: "000000000000000000000001", requestId: "request", appointments: [{ date: "2026-11-01" }] });
  });

  it("returns semantic errors with zero-based row index", async () => {
    mocks.createTreatmentPlan.mockRejectedValue(new TreatmentPlanError("TIME_SLOT_UNAVAILABLE", "Choose another time.", 409, 0));
    const response = await POST(request(), context);
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: "TIME_SLOT_UNAVAILABLE", message: "Choose another time.", rowIndex: 0 });
  });

  it("returns safe invalid JSON and server errors without leaking internals", async () => {
    const req = request();
    req.json.mockRejectedValue(new SyntaxError("unexpected token and private body"));
    let response = await POST(req, context);
    expect(response.status).toBe(400);
    expect((await response.json()).error).toBe("INVALID_JSON");
    mocks.createTreatmentPlan.mockRejectedValue(new Error("private database password"));
    response = await POST(request(), context);
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: "TREATMENT_PLAN_FAILED", message: "The treatment plan could not be saved. Retry this same request ID." });
  });
});

describe("saved program page HTTP boundary", () => {
  it.each([[null, null, 401], ["customer-token", { role: "customer" }, 403]])("protects program pages for cookie %s", async (cookie, identity, status) => {
    expect(route.GET).toBeTypeOf("function");
    mocks.verifyToken.mockReturnValue(identity);
    expect((await route.GET(request(cookie), context)).status).toBe(status);
    expect(mocks.listPlans).not.toHaveBeenCalled();
  });

  it("uses the protected customer's ID and cursor, and disables response caching", async () => {
    expect(route.GET).toBeTypeOf("function");
    mocks.listPlans.mockResolvedValue({ plans: [], plansPagination: { hasMore: false, nextCursor: null } });
    const req = request();
    req.url += "?cursor=000000000000000000000010";
    const result = await route.GET(req, context);
    expect(result.status).toBe(200);
    expect(result.headers.get("Cache-Control")).toBe("private, no-store");
    expect(await result.json()).toEqual({ plans: [], plansPagination: { hasMore: false, nextCursor: null } });
    expect(mocks.listPlans).toHaveBeenCalledWith("000000000000000000000001", { cursor: "000000000000000000000010" });
    expect(mocks.createTreatmentPlan).not.toHaveBeenCalled();
  });

  it.each([[400, "INVALID_CURSOR"], [404, "USER_NOT_FOUND"], [500, "PLANS_UNAVAILABLE"]])("returns safe paginated-list error %s", async (status, code) => {
    expect(route.GET).toBeTypeOf("function");
    mocks.listPlans.mockRejectedValue(Object.assign(new Error("private database details"), { status, code }));
    const result = await route.GET(request(), context);
    expect(result.status).toBe(status);
    expect(result.headers.get("Cache-Control")).toBe("private, no-store");
    const body = await result.json();
    expect(body.error).toBe(code);
    expect(JSON.stringify(body)).not.toContain("private database details");
  });
});
