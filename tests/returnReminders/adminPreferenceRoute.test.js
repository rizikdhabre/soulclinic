import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ verify: vi.fn(), collection: vi.fn(), findOne: vi.fn(), get: vi.fn(), set: vi.fn(), getSettings: vi.fn() }));
vi.mock("@/lib/jwt", () => ({ verifyToken: mocks.verify }));
vi.mock("@/lib/db", () => ({ getCollection: mocks.collection }));
vi.mock("@/lib/returnReminderPreferences", () => ({ getReturnReminderPreference: mocks.get, setReturnReminderPreference: mocks.set }));
vi.mock("@/lib/returnReminderSettings", () => ({ getReturnReminderSettings: mocks.getSettings }));
const route = await import("@/app/api/admin/users/[userId]/return-reminders/route");
const userId = "000000000000000000000011";
const context = (id = userId) => ({ params: Promise.resolve({ userId: id }) });
const request = (body, token = "admin-token") => ({ cookies: { get: () => token ? { value: token } : undefined }, json: vi.fn().mockResolvedValue(body) });

beforeEach(() => {
  vi.resetAllMocks();
  mocks.verify.mockReturnValue({ role: "admin", adminId: "admin-one" });
  mocks.collection.mockResolvedValue({ findOne: mocks.findOne });
  mocks.findOne.mockResolvedValue({ phone: "0501234567" });
  mocks.get.mockResolvedValue({ enabled: false });
  mocks.getSettings.mockResolvedValue({ schedule: { mode: "default" }, scheduleRevision: 0 });
  mocks.set.mockImplementation(async ({ enabled }) => ({ enabled }));
});

describe("admin return reminder preferences", () => {
  it.each(["GET", "PATCH"])("%s requires admin authorization before reading data or request input", async method => {
    expect(route[method]).toBeTypeOf("function");
    for (const [token, identity, status] of [[null, null, 401], ["invalid", null, 401], ["customer", { role: "customer" }, 403]]) {
      mocks.verify.mockReturnValue(identity);
      const req = request({ enabled: true, consentConfirmed: true }, token);
      const response = await route[method](req, context());
      expect(response.status).toBe(status);
      expect(req.json).not.toHaveBeenCalled();
      expect(mocks.collection).not.toHaveBeenCalled();
      expect(mocks.set).not.toHaveBeenCalled();
    }
  });

  it("reads only the customer's saved phone and returns an uncached default-off preference", async () => {
    expect(route.GET).toBeTypeOf("function");
    const response = await route.GET(request(), context());
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ enabled: false, schedule: { mode: "default" }, scheduleRevision: 0 });
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
    expect(mocks.collection).toHaveBeenCalledWith("usersData");
    expect(mocks.findOne.mock.calls[0][0]._id.toHexString()).toBe(userId);
    expect(mocks.findOne.mock.calls[0][1]).toEqual({ projection: { phone: 1 } });
    expect(mocks.get).toHaveBeenCalledWith({ phone: "+972501234567" });
    expect(mocks.set).not.toHaveBeenCalled();
  });

  it.each(["GET", "PATCH"])("%s rejects invalid customer IDs before database access", async method => {
    expect(route[method]).toBeTypeOf("function");
    expect((await route[method](request({ enabled: false }), context("bad-id"))).status).toBe(400);
    expect(mocks.collection).not.toHaveBeenCalled();
    expect(mocks.set).not.toHaveBeenCalled();
  });

  it.each(["GET", "PATCH"])("%s rejects unknown customers and unusable phone numbers", async method => {
    expect(route[method]).toBeTypeOf("function");
    mocks.findOne.mockResolvedValueOnce(null);
    expect((await route[method](request({ enabled: false }), context())).status).toBe(404);
    for (const phone of [null, "not-a-phone", {}, 501234567]) {
      mocks.findOne.mockResolvedValueOnce({ phone });
      expect((await route[method](request({ enabled: false }), context())).status).toBe(400);
    }
    expect(mocks.get).not.toHaveBeenCalled();
    expect(mocks.set).not.toHaveBeenCalled();
  });

  it.each([null, {}, [], { enabled: "true" }, { enabled: 1 }, { enabled: true }, { enabled: true, consentConfirmed: "true" }, { enabled: true, consentConfirmed: false }])("rejects malformed or unattested permission updates: %j", async body => {
    expect(route.PATCH).toBeTypeOf("function");
    expect((await route.PATCH(request(body), context())).status).toBe(400);
    expect(mocks.set).not.toHaveBeenCalled();
  });

  it("records explicit permission against the server phone with admin audit identity", async () => {
    expect(route.PATCH).toBeTypeOf("function");
    const response = await route.PATCH(request({ enabled: true, consentConfirmed: true, phone: "0509999999", adminId: "spoofed-admin" }), context());
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ enabled: true });
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
    expect(mocks.set).toHaveBeenCalledExactlyOnceWith({ phone: "+972501234567", enabled: true, source: "admin", adminId: "admin-one" });
  });

  it("allows an admin to disable without permission attestation", async () => {
    expect(route.PATCH).toBeTypeOf("function");
    const response = await route.PATCH(request({ enabled: false }), context());
    expect(await response.json()).toEqual({ enabled: false });
    expect(mocks.set).toHaveBeenCalledExactlyOnceWith({ phone: "+972501234567", enabled: false, source: "admin", adminId: "admin-one" });
  });

  it("returns safe errors for bad JSON and failed persistence without reporting a saved preference", async () => {
    expect(route.PATCH).toBeTypeOf("function");
    const req = request();
    req.json.mockRejectedValue(new SyntaxError("private request"));
    let response = await route.PATCH(req, context());
    expect(response.status).toBe(400);
    mocks.set.mockRejectedValue(new Error("private database connection"));
    response = await route.PATCH(request({ enabled: false }), context());
    expect(response.status).toBe(500);
    const body = await response.json();
    expect(body.enabled).toBeUndefined();
    expect(JSON.stringify(body)).not.toContain("private");
  });

  it("does not invent an off preference when database reads fail", async () => {
    mocks.get.mockRejectedValue(new Error("private database connection"));
    const response = await route.GET(request(), context());
    expect(response.status).toBe(500);
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
    const body = await response.json();
    expect(body.enabled).toBeUndefined();
    expect(JSON.stringify(body)).not.toContain("private");
    expect(mocks.set).not.toHaveBeenCalled();
  });
});
