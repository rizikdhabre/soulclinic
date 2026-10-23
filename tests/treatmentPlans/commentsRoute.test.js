import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ verify: vi.fn(), get: vi.fn(), add: vi.fn(), update: vi.fn(), remove: vi.fn() }));
vi.mock("@/lib/jwt", () => ({ verifyToken: mocks.verify }));
vi.mock("@/lib/treatmentPlanComments", () => ({ getTreatmentPlanComments: mocks.get, addTreatmentPlanComment: mocks.add,
  updateTreatmentPlanComment: mocks.update, deleteTreatmentPlanComment: mocks.remove }));
const base = await import("@/app/api/admin/users/[userId]/treatment-plans/[planId]/comments/route").catch(() => ({}));
const item = await import("@/app/api/admin/users/[userId]/treatment-plans/[planId]/comments/[commentId]/route").catch(() => ({}));
const userId = "000000000000000000000001", planId = "000000000000000000000010";
const commentId = "0ae84a16-93f5-49ae-a3c4-e12de257b9eb";
const context = { params: Promise.resolve({ userId, planId, commentId }) };
const request = (token = "admin", body = {}) => ({ cookies: { get: () => token ? { value: token } : undefined }, json: vi.fn().mockResolvedValue(body) });
beforeEach(() => { vi.resetAllMocks(); mocks.verify.mockReturnValue({ role: "admin" }); });
const operations = [["GET", base, "get"], ["POST", base, "add"], ["PATCH", item, "update"], ["DELETE", item, "remove"]];

describe("private program comment routes", () => {
  it.each(operations)("protects %s and disables caching before reading any mutation body", async (method, route, operation) => {
    expect(route[method]).toBeTypeOf("function");
    for (const [token, role, status] of [[null, null, 401], ["customer", { role: "customer" }, 403]]) {
      mocks.verify.mockReturnValue(role);
      const req = request(token);
      const response = await route[method](req, context);
      expect(response.status).toBe(status);
      expect(response.headers.get("Cache-Control")).toBe("private, no-store");
      expect(req.json).not.toHaveBeenCalled();
      expect(mocks[operation]).not.toHaveBeenCalled();
    }
  });

  it.each(operations)("%s uses route ownership and returns authoritative comments", async (method, route, operation) => {
    expect(route[method]).toBeTypeOf("function");
    const result = { ...(method !== "GET" ? { success: true } : {}), comments: [], commentsVersion: 4 };
    mocks[operation].mockResolvedValue(result);
    const req = request("admin", { userId: "forged", planId: "forged", commentId, text: "تعليق", revision: 2 });
    const response = await route[method](req, context);
    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
    expect(await response.json()).toEqual(result);
    const expected = method === "GET" ? { userId, planId } : method === "POST" ? { userId, planId, commentId, text: "تعليق" }
      : method === "PATCH" ? { userId, planId, commentId, text: "تعليق", revision: 2 } : { userId, planId, commentId, revision: 2 };
    expect(mocks[operation]).toHaveBeenCalledExactlyOnceWith(expected);
  });

  it.each(operations.slice(1))("%s rejects malformed JSON before touching comments", async (method, route, operation) => {
    expect(route[method]).toBeTypeOf("function");
    const req = request();
    req.json.mockRejectedValue(new Error("private body"));
    const response = await route[method](req, context);
    expect(response.status).toBe(400);
    expect((await response.json()).error).toBe("INVALID_JSON");
    expect(mocks[operation]).not.toHaveBeenCalled();
  });

  it.each([[400, "INVALID_COMMENT_TEXT"], [404, "PLAN_NOT_FOUND"], [409, "COMMENT_CONFLICT"], [409, "COMMENT_ID_REUSED"], [409, "COMMENT_LIMIT_REACHED"], [500, "COMMENTS_UNAVAILABLE"]])("returns safe %s %s errors", async (status, code) => {
    expect(item.PATCH).toBeTypeOf("function");
    mocks.update.mockRejectedValue(Object.assign(new Error("private database details"), { status, code }));
    const response = await item.PATCH(request(), context);
    expect(response.status).toBe(status);
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
    const result = await response.json();
    expect(result.error).toBe(code);
    expect(JSON.stringify(result)).not.toContain("private database details");
  });
});
