import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ verify: vi.fn(), remove: vi.fn() }));
vi.mock("@/lib/jwt", () => ({ verifyToken: mocks.verify }));
vi.mock("@/lib/treatmentPlanDeletion", () => ({ deleteCanceledTreatmentPlan: mocks.remove }));
const route = await import("@/app/api/admin/users/[userId]/treatment-plans/[planId]/route").catch(() => ({}));
const request = (token = "token") => ({ cookies: { get: () => token ? { value: token } : undefined } });
const context = { params: Promise.resolve({ userId: "000000000000000000000001", planId: "000000000000000000000002" }) };
beforeEach(() => { vi.resetAllMocks(); mocks.verify.mockReturnValue({ role: "admin" }); });
describe("canceled plan DELETE authorization", () => {
  it.each([[null, null, 401], ["customer", { role: "customer" }, 403]])("blocks %s before deletion", async (token, identity, status) => {
    expect(route.DELETE).toBeTypeOf("function");
    mocks.verify.mockReturnValue(identity);
    expect((await route.DELETE(request(token), context)).status).toBe(status);
    expect(mocks.remove).not.toHaveBeenCalled();
  });
  it("uses both route IDs and does not cache results", async () => {
    expect(route.DELETE).toBeTypeOf("function");
    mocks.remove.mockResolvedValue({ success: true, deleted: true });
    const result = await route.DELETE(request(), context);
    expect(await result.json()).toEqual({ success: true, deleted: true });
    expect(result.headers.get("Cache-Control")).toBe("private, no-store");
    expect(mocks.remove).toHaveBeenCalledWith({ userId: "000000000000000000000001", planId: "000000000000000000000002" });
  });
  it.each([[400, "INVALID_PLAN_ID"], [404, "PLAN_NOT_FOUND"], [409, "PLAN_NOT_FULLY_CANCELED"], [503, "TRANSACTIONS_REQUIRED"], [500, "PLAN_DELETE_FAILED"]])("returns safe error %s", async (status, code) => {
    expect(route.DELETE).toBeTypeOf("function");
    mocks.remove.mockRejectedValue(Object.assign(new Error("private details"), { status, code }));
    const response = await route.DELETE(request(), context);
    expect(response.status).toBe(status);
    const body = await response.json();
    expect(body.error).toBe(code);
    expect(JSON.stringify(body)).not.toContain("private details");
  });
});
