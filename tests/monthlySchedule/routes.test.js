import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ verify: vi.fn(), preview: vi.fn(), apply: vi.fn(), state: vi.fn() }));
vi.mock("@/lib/jwt", () => ({ verifyToken: mocks.verify }));
vi.mock("@/lib/db", () => { throw new Error("Production database import forbidden in monthly schedule route tests."); });
vi.mock("@/lib/monthlySchedule", () => ({ previewMonthlySchedule: mocks.preview, applyMonthlySchedule: mocks.apply, getMonthlyScheduleState: mocks.state }));
const preview = await import("@/app/api/admin/monthly-schedule/preview/route").catch(() => ({}));
const apply = await import("@/app/api/admin/monthly-schedule/apply/route").catch(() => ({}));
const state = await import("@/app/api/admin/monthly-schedule/state/route").catch(() => ({}));
const operations = [["preview", preview], ["apply", apply]];
const request = (token = "admin", body = {}) => ({ cookies: { get: () => token ? { value: token } : undefined }, json: vi.fn().mockResolvedValue(body) });
beforeEach(() => { vi.resetAllMocks(); mocks.verify.mockReturnValue({ role: "admin" }); });

describe.each(operations)("monthly schedule %s boundary", (operation, route) => {
  it.each([[null, null, 401], ["invalid", null, 401], ["customer", { role: "customer" }, 403]])("requires an administrator before reading or acting on cookie %s", async (token, identity, status) => {
    expect(route.POST).toBeTypeOf("function");
    mocks.verify.mockReturnValue(identity);
    const req = request(token);
    const response = await route.POST(req);
    expect(response.status).toBe(status);
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
    expect(req.json).not.toHaveBeenCalled();
    expect(mocks[operation]).not.toHaveBeenCalled();
    expect((await response.json()).error).toBe(status === 401 ? "UNAUTHORIZED" : "FORBIDDEN");
  });

  it("returns the authoritative result with private no-store headers", async () => {
    expect(route.POST).toBeTypeOf("function");
    const body = { month: "2026-11", groups: [{ weekdays: [1], mode: "closed" }], excludedDates: [], customizedDays: "preserve", requestId: "id", previewToken: "token" };
    const expected = operation === "preview" ? { previewToken: "token", days: [], summary: { apply: 0, skipped: 0, existingAppointments: 0, affectedAppointments: 0 } } : { success: true, requestId: "id", summary: {}, appliedDates: [] };
    mocks[operation].mockResolvedValue(expected);
    const response = await route.POST(request("admin", body));
    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
    expect(await response.json()).toEqual(expected);
    expect(mocks[operation]).toHaveBeenCalledExactlyOnceWith(body);
  });

  it("rejects invalid JSON without calling the service or leaking body details", async () => {
    expect(route.POST).toBeTypeOf("function");
    const req = request();
    req.json.mockRejectedValue(new SyntaxError("secret request body"));
    const response = await route.POST(req);
    expect(response.status).toBe(400);
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
    expect((await response.json()).error).toBe("INVALID_SCHEDULE");
    expect(mocks[operation]).not.toHaveBeenCalled();
  });

  it.each([[400, "INVALID_SCHEDULE"], [400, "NO_DATES_TO_APPLY"], [409, "SCHEDULE_CHANGED"], [409, "APPOINTMENT_CONFLICT"], [409, "REQUEST_ID_REUSED"], [503, "TRANSACTIONS_REQUIRED"], [503, "SCHEDULE_STORAGE_UNAVAILABLE"]])("returns safe %s %s responses", async (status, code) => {
    expect(route.POST).toBeTypeOf("function");
    mocks[operation].mockRejectedValue(Object.assign(new Error("secret database details"), { code, status }));
    const response = await route.POST(request());
    expect(response.status).toBe(status);
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
    const body = await response.json();
    expect(body.error).toBe(code);
    expect(body.message).toBeTypeOf("string");
    expect(JSON.stringify(body)).not.toContain("secret");
  });

  it("maps unexpected failures to a safe storage error", async () => {
    expect(route.POST).toBeTypeOf("function");
    mocks[operation].mockRejectedValue(Object.assign(new Error("secret host URI"), { code: "UNEXPECTED_DATABASE_ERROR", status: 418 }));
    const response = await route.POST(request());
    expect(response.status).toBe(503);
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
    expect((await response.json()).error).toBe("SCHEDULE_STORAGE_UNAVAILABLE");
  });
});

it("returns only valid date/time conflict details with the safe Arabic conflict message", async () => {
  mocks.apply.mockRejectedValue(Object.assign(new Error("secret customer name"), { code: "APPOINTMENT_CONFLICT", conflicts: [
    { date: "2026-11-09", time: "11:00", phone: "secret", firstName: "private" },
    { date: "2026-11-09", time: "11:00" },
    { date: "invalid", time: "11:00" }, { date: "2026-11-09", time: "private" }, null,
  ] }));
  const response = await apply.POST(request());
  expect(response.status).toBe(409);
  const body = await response.json();
  expect(body).toMatchObject({ error: "APPOINTMENT_CONFLICT", conflicts: [{ date: "2026-11-09", time: "11:00" }] });
  expect(body.message).toMatch(/[\u0600-\u06ff]/);
  expect(JSON.stringify(body)).not.toMatch(/secret|private|phone|firstName/);
});

describe("monthly schedule state boundary", () => {
  const getRequest = (token = "admin", query = "month=2026-11") => ({ ...request(token), url: `http://localhost/api/admin/monthly-schedule/state?${query}` });
  it.each([[null, null, 401], ["invalid", null, 401], ["customer", { role: "customer" }, 403]])("authenticates before reading saved month for cookie %s", async (token, identity, status) => {
    expect(state.GET).toBeTypeOf("function");
    mocks.verify.mockReturnValue(identity);
    const response = await state.GET(getRequest(token));
    expect(response.status).toBe(status);
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
    expect(mocks.state).not.toHaveBeenCalled();
  });
  it("reads a saved month from the query without a JSON body and returns no-store", async () => {
    expect(state.GET).toBeTypeOf("function");
    const saved = { month: "2026-11", days: [{ date: "2026-11-01", weekday: 0, times: ["10:00"], blockedTimes: [], appointmentTimes: [], valid: true, customized: true }] };
    mocks.state.mockResolvedValue(saved);
    const req = getRequest();
    const response = await state.GET(req);
    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
    expect(await response.json()).toEqual(saved);
    expect(mocks.state).toHaveBeenCalledExactlyOnceWith({ month: "2026-11" });
    expect(req.json).not.toHaveBeenCalled();
  });
  it.each(["", "month=2026-13", "month=2026-1", "month=2026-11&month=2026-12"])("rejects invalid query %s before invoking storage", async (query) => {
    expect(state.GET).toBeTypeOf("function");
    const response = await state.GET(getRequest("admin", query));
    expect(response.status).toBe(400);
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
    expect((await response.json()).error).toBe("INVALID_SCHEDULE");
    expect(mocks.state).not.toHaveBeenCalled();
  });
  it("returns safe no-store responses for storage failures", async () => {
    expect(state.GET).toBeTypeOf("function");
    mocks.state.mockRejectedValue(new Error("secret storage URL"));
    const response = await state.GET(getRequest());
    expect(response.status).toBe(503);
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
    expect(await response.json()).toMatchObject({ error: "SCHEDULE_STORAGE_UNAVAILABLE" });
  });
});
