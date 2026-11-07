import { beforeEach, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ saveMain: vi.fn(), saveServices: vi.fn(), token: vi.fn(), invalidate: vi.fn() }));
vi.mock("@/lib/jwt", () => ({ verifyToken: mocks.token }));
vi.mock("@/lib/db", () => ({ getCollection: () => { throw new Error("Live DB forbidden"); } }));
vi.mock("@/lib/treatmentOrdering", () => ({ saveMainTreatmentOrder: mocks.saveMain, saveServiceOrder: mocks.saveServices }));
vi.mock("@/lib/cache/redisReadCache", () => ({ advanceTreatmentCatalogCacheGeneration: mocks.invalidate }));
const main = await import("@/app/api/admin/treatments/reorder/route").catch(() => ({}));
const services = await import("@/app/api/admin/treatments/services/reorder/route");
const request = (body, authenticated = true) => ({ cookies: { get: () => authenticated ? { value: "test-token" } : undefined }, json: async () => body });
beforeEach(() => { vi.clearAllMocks(); mocks.token.mockReturnValue({ role: "admin", adminId: "admin-1" }); mocks.invalidate.mockResolvedValue(true); });

it.each(["main", "services"])("protects %s ordering before reading or saving", async type => {
  const handler = type === "main" ? main.PUT : services.PUT;
  expect(handler).toBeTypeOf("function");
  expect((await handler(request({}, false))).status).toBe(401);
  mocks.token.mockReturnValue({ role: "customer", adminId: "admin-1" });
  expect((await handler(request({}))).status).toBe(403);
  expect(mocks.saveMain).not.toHaveBeenCalled(); expect(mocks.saveServices).not.toHaveBeenCalled();
});

it.each(["main", "services"])("rejects an old account's %s outbox after account switch", async type => {
  const handler = type === "main" ? main.PUT : services.PUT;
  expect((await handler(request({ owner: "other-admin", order: [] }))).status).toBe(403);
  expect(mocks.saveMain).not.toHaveBeenCalled(); expect(mocks.saveServices).not.toHaveBeenCalled();
});

it("passes only IDs and retry identity to ordering persistence", async () => {
  const body = { owner: "admin-1", treatmentId: "123", order: ["b", "a"], clientId: "browser", sequence: 4, services: [{ title: "must not copy" }] };
  expect((await services.PUT(request(body))).status).toBe(200);
  expect(mocks.saveServices).toHaveBeenCalledWith("123", ["b", "a"], { request: { clientId: "browser", sequence: 4 } });
  expect(mocks.invalidate).toHaveBeenCalledTimes(1);
});

it("does not acknowledge a failed persistence request", async () => {
  mocks.saveMain.mockRejectedValueOnce(Object.assign(new Error("retry"), { status: 409 }));
  expect((await main.PUT(request({ order: [] }))).status).toBe(409);
  expect(mocks.invalidate).not.toHaveBeenCalled();
});
