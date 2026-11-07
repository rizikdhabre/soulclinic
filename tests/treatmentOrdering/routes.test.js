import { beforeEach, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ saveMain: vi.fn(), saveServices: vi.fn(), token: vi.fn(), start: vi.fn(), workflow: vi.fn() }));
vi.mock("@/lib/jwt", () => ({ verifyToken: mocks.token }));
vi.mock("@/lib/db", () => ({ getCollection: () => { throw new Error("Live DB forbidden"); } }));
vi.mock("@/lib/treatmentOrdering", () => ({ queueTreatmentOrder: mocks.saveMain, queueServiceOrder: mocks.saveServices }));
vi.mock("workflow/api", () => ({ start: mocks.start }));
vi.mock("@/workflows/treatment-order", () => ({ scheduleTreatmentOrder: mocks.workflow }));
const main = await import("@/app/api/admin/treatments/reorder/route").catch(() => ({}));
const services = await import("@/app/api/admin/treatments/services/reorder/route");
const request = (body, authenticated = true) => ({ cookies: { get: () => authenticated ? { value: "test-token" } : undefined }, json: async () => body });
beforeEach(() => { vi.clearAllMocks(); mocks.token.mockReturnValue({ role: "admin", adminId: "admin-1" }); mocks.saveMain.mockResolvedValue("main"); mocks.saveServices.mockResolvedValue("123"); mocks.start.mockResolvedValue({ runId: "durable-run" }); });

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
  expect((await services.PUT(request(body))).status).toBe(202);
  expect(mocks.saveServices).toHaveBeenCalledWith("123", ["b", "a"], { request: { clientId: "browser", sequence: 4 } });
  expect(mocks.start).toHaveBeenCalledWith(mocks.workflow, ["123"]);
});

it("does not acknowledge a failed persistence request", async () => {
  mocks.saveMain.mockRejectedValueOnce(Object.assign(new Error("retry"), { status: 409 }));
  expect((await main.PUT(request({ order: [] }))).status).toBe(409);
  expect(mocks.start).not.toHaveBeenCalled();
});

it("responds only after durable workflow start succeeds", async () => {
  let finishStart;
  mocks.start.mockReturnValueOnce(new Promise(resolve => { finishStart = resolve; }));
  let response;
  const pending = main.PUT(request({ order: [], clientId: "browser", sequence: 1 })).then(value => { response = value; });
  await vi.waitFor(() => expect(mocks.start).toHaveBeenCalled());
  expect(response).toBeUndefined();
  finishStart({ runId: "durable-run" });
  await pending;
  expect(response.status).toBe(202);
  expect(await response.json()).toMatchObject({ accepted: true });
});

it("does not acknowledge an intent when durable workflow start fails", async () => {
  mocks.start.mockRejectedValueOnce(new Error("workflow unavailable"));
  expect((await main.PUT(request({ order: [] }))).status).toBeGreaterThanOrEqual(500);
  expect(mocks.saveMain).toHaveBeenCalled();
});
