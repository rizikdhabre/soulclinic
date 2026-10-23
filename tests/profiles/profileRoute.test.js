import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ verify: vi.fn(), load: vi.fn() }));
vi.mock("@/lib/jwt", () => ({ verifyToken: mocks.verify }));
vi.mock("@/lib/adminCustomerProfile", () => ({ getAdminCustomerProfile: mocks.load }));
const route = await import("@/app/api/admin/users/[userId]/route").catch(() => ({}));
const request = (token) => ({ cookies: { get: () => token ? { value: token } : undefined } });
const context = { params: Promise.resolve({ userId: "000000000000000000000011" }) };

beforeEach(() => vi.resetAllMocks());

describe("customer profile route access", () => {
  it("blocks missing sessions before profile data access", async () => {
    expect(route.GET).toBeTypeOf("function");
    expect((await route.GET(request(), context)).status).toBe(401);
    expect(mocks.load).not.toHaveBeenCalled();
  });
  it("blocks a valid non-admin role", async () => {
    expect(route.GET).toBeTypeOf("function");
    mocks.verify.mockReturnValue({ role: "customer" });
    expect((await route.GET(request("token"), context)).status).toBe(403);
    expect(mocks.load).not.toHaveBeenCalled();
  });
  it("awaits route parameters and prevents caching customer data", async () => {
    expect(route.GET).toBeTypeOf("function");
    mocks.verify.mockReturnValue({ role: "admin" });
    mocks.load.mockResolvedValue({ user: { firstName: "عميل" }, appointments: [], plans: [] });
    const response = await route.GET(request("token"), context);
    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
    expect(mocks.load).toHaveBeenCalledWith("000000000000000000000011");
  });
  it("returns safe errors without exposing provider/database internals", async () => {
    expect(route.GET).toBeTypeOf("function");
    mocks.verify.mockReturnValue({ role: "admin" });
    mocks.load.mockRejectedValue(new Error("private connection details"));
    const response = await route.GET(request("token"), context);
    expect(response.status).toBe(500);
    expect(JSON.stringify(await response.json())).not.toContain("private connection details");
  });
});
