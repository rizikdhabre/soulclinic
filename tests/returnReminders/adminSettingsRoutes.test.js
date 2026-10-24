import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { MongoClient, ObjectId } from "mongodb";
import { MongoMemoryServer } from "mongodb-memory-server-core";

const mocks = vi.hoisted(() => ({ verify: vi.fn(), getCollection: vi.fn() }));
vi.mock("@/lib/jwt", () => ({ verifyToken: mocks.verify }));
vi.mock("@/lib/db", () => ({ getCollection: mocks.getCollection }));
const preferencesRoute = await import("@/app/api/admin/users/[userId]/return-reminders/route");
const commentsRoute = await import("@/app/api/admin/users/[userId]/return-reminders/comments/route").catch(() => ({}));
const commentRoute = await import("@/app/api/admin/users/[userId]/return-reminders/comments/[commentId]/route").catch(() => ({}));
const USER_ID = "000000000000000000000011";
const ALIAS_USER_ID = "000000000000000000000012";
const OTHER_USER_ID = "000000000000000000000013";
const PHONE = "+972521234567";
const ID = "11111111-1111-4111-8111-111111111111";
const CUSTOM = { mode: "custom", value: 6, unit: "months" };
const context = (userId = USER_ID, commentId = ID) => ({ params: Promise.resolve({ userId, commentId }) });
const request = (body, token = "admin") => ({ cookies: { get: () => token ? { value: token } : undefined }, json: vi.fn().mockResolvedValue(body) });
let server, client, db;
beforeAll(async () => {
  server = await MongoMemoryServer.create({ instance: { ip: "127.0.0.1", launchTimeout: 120_000 }, spawn: { windowsHide: true } });
  const uri = server.getUri();
  if (!uri.startsWith("mongodb://127.0.0.1:")) throw new Error("Expected loopback test MongoDB");
  client = new MongoClient(uri);
  await client.connect();
  db = client.db("return_reminder_admin_settings_routes_test");
}, 120_000);
afterAll(async () => { await client?.close(); await server?.stop(); });
beforeEach(async () => {
  vi.resetAllMocks();
  await db.dropDatabase();
  mocks.getCollection.mockImplementation(async name => db.collection(name));
  mocks.verify.mockReturnValue({ role: "admin", adminId: "verified-admin" });
  await db.collection("usersData").insertMany([
    { _id: new ObjectId(USER_ID), phone: "052-123-4567" },
    { _id: new ObjectId(ALIAS_USER_ID), phone: "00972521234567" },
    { _id: new ObjectId(OTHER_USER_ID), phone: "0509999999" },
  ]);
});

const endpoints = [
  ["settings GET", preferencesRoute, "GET"], ["settings PATCH", preferencesRoute, "PATCH"],
  ["comments GET", commentsRoute, "GET"], ["comments POST", commentsRoute, "POST"],
  ["comment PATCH", commentRoute, "PATCH"], ["comment DELETE", commentRoute, "DELETE"],
];

describe("private return reminder administration routes", () => {
  it.each(endpoints)("%s denies non-admins before body or database access and never caches", async (_name, route, method) => {
    expect(route[method]).toBeTypeOf("function");
    for (const [token, identity, status] of [[null, null, 401], ["bad", null, 401], ["customer", { role: "customer" }, 403]]) {
      mocks.verify.mockReturnValue(identity);
      const req = request({}, token);
      const response = await route[method](req, context());
      expect(response.status).toBe(status);
      expect(response.headers.get("Cache-Control")).toBe("private, no-store");
      expect(req.json).not.toHaveBeenCalled();
      expect(mocks.getCollection).not.toHaveBeenCalled();
    }
  });

  it("reads default schedules and saves custom/default via CAS without changing consent or trusting request identity", async () => {
    await db.collection("returnReminderPreferences").insertOne({ _id: PHONE, enabled: false, source: "admin", policyRevision: "test", updatedAt: new Date("2026-10-24T10:00:00Z"), adminId: "consent-admin" });
    const before = await db.collection("returnReminderPreferences").findOne({ _id: PHONE });
    let response = await preferencesRoute.GET(request(), context());
    expect(await response.json()).toEqual({ enabled: false, schedule: { mode: "default" }, scheduleRevision: 0 });
    response = await preferencesRoute.PATCH(request({ schedule: CUSTOM, scheduleRevision: 0, phone: "+972509999999", adminId: "spoofed" }), context());
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ enabled: false, schedule: CUSTOM, scheduleRevision: 1 });
    expect(await db.collection("returnReminderSettings").findOne({ _id: PHONE })).toMatchObject({ scheduleUpdatedByAdminId: "verified-admin" });
    response = await preferencesRoute.GET(request(), context(ALIAS_USER_ID));
    expect(await response.json()).toEqual({ enabled: false, schedule: CUSTOM, scheduleRevision: 1 });
    response = await preferencesRoute.PATCH(request({ schedule: { mode: "default" }, scheduleRevision: 1 }), context(ALIAS_USER_ID));
    expect(await response.json()).toEqual({ enabled: false, schedule: { mode: "default" }, scheduleRevision: 2 });
    response = await preferencesRoute.PATCH(request({ schedule: CUSTOM, scheduleRevision: 1 }), context());
    expect(response.status).toBe(409);
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
    expect((await response.json()).error).toBe("RETURN_REMINDER_SETTINGS_CONFLICT");
    expect(await db.collection("returnReminderPreferences").findOne({ _id: PHONE })).toEqual(before);
  });

  it.each([
    { schedule: CUSTOM }, { schedule: CUSTOM, scheduleRevision: "0" }, { schedule: CUSTOM, scheduleRevision: -1 },
    { schedule: { mode: "custom", value: 0, unit: "days" }, scheduleRevision: 0 },
    { schedule: { mode: "default", value: 1 }, scheduleRevision: 0 },
    { schedule: CUSTOM, scheduleRevision: 0, enabled: false },
    { enabled: true, consentConfirmed: true, scheduleRevision: 0 },
    { schedule: CUSTOM, scheduleRevision: 0, consentConfirmed: true },
  ])("rejects malformed or combined schedule/consent requests %j", async body => {
    const response = await preferencesRoute.PATCH(request(body), context());
    expect(response.status).toBe(400);
    expect(await db.collection("returnReminderSettings").countDocuments()).toBe(0);
    expect(await db.collection("returnReminderPreferences").countDocuments()).toBe(0);
  });

  it("fails closed when saved schedule is malformed without exposing internal data", async () => {
    await db.collection("returnReminderSettings").insertOne({ _id: PHONE, schedule: { mode: "custom", value: 0, unit: "days" }, scheduleRevision: 1, adminComments: [{ text: "private note" }] });
    const response = await preferencesRoute.GET(request(), context());
    expect(response.status).toBe(500);
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
    const text = JSON.stringify(await response.json());
    expect(text).not.toContain("private note");
    expect(text).not.toContain(PHONE);
  });

  it("adds, edits, deletes and retries private comments across phone aliases while keeping consent disabled", async () => {
    expect(commentsRoute.POST).toBeTypeOf("function");
    await db.collection("returnReminderPreferences").insertOne({ _id: PHONE, enabled: false });
    let response = await commentsRoute.POST(request({ commentId: ID, text: "Private note", phone: "+972509999999" }), context());
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ comments: [{ _id: ID, text: "Private note", revision: 1 }], commentsVersion: 1 });
    response = await commentsRoute.GET(request(), context(ALIAS_USER_ID));
    expect(await response.json()).toMatchObject({ comments: [{ _id: ID }], commentsVersion: 1 });
    response = await commentRoute.PATCH(request({ text: "Edited", revision: 1 }), context(ALIAS_USER_ID));
    expect(await response.json()).toMatchObject({ comments: [{ text: "Edited", revision: 2 }], commentsVersion: 2 });
    expect((await commentRoute.PATCH(request({ text: "Stale", revision: 1 }), context())).status).toBe(409);
    expect((await commentRoute.DELETE(request({ revision: 1 }), context())).status).toBe(409);
    expect((await commentRoute.PATCH(request({ text: "Wrong phone", revision: 2 }), context(OTHER_USER_ID))).status).toBe(404);
    response = await commentRoute.DELETE(request({ revision: 2 }), context());
    expect(await response.json()).toEqual({ comments: [], commentsVersion: 3 });
    response = await commentRoute.DELETE(request({ revision: 2 }), context());
    expect(await response.json()).toEqual({ comments: [], commentsVersion: 3 });
    expect((await commentsRoute.POST(request({ commentId: ID, text: "Private note" }), context())).status).toBe(409);
    expect(await db.collection("returnReminderPreferences").findOne({ _id: PHONE })).toEqual({ _id: PHONE, enabled: false });
  });

  it.each(endpoints)("%s rejects bad user identity, missing customers and invalid phones", async (_name, route, method) => {
    expect(route[method]).toBeTypeOf("function");
    const body = method === "PATCH" && route === preferencesRoute ? { schedule: CUSTOM, scheduleRevision: 0 } : { commentId: ID, text: "Note", revision: 1 };
    expect((await route[method](request(body), context("bad-id"))).status).toBe(400);
    expect((await route[method](request(body), context("000000000000000000000099"))).status).toBe(404);
    await db.collection("usersData").updateOne({ _id: new ObjectId(USER_ID) }, { $set: { phone: { $ne: null } } });
    expect((await route[method](request(body), context())).status).toBe(400);
  });

  it("rejects bad JSON and malformed comment input and sanitizes database errors", async () => {
    expect(commentsRoute.POST).toBeTypeOf("function");
    for (const [route, method] of [[commentsRoute, "POST"], [commentRoute, "PATCH"], [commentRoute, "DELETE"]]) {
      const badJson = request();
      badJson.json.mockRejectedValue(new SyntaxError("sensitive request"));
      expect((await route[method](badJson, context())).status).toBe(400);
      for (const body of [null, [], {}, { commentId: "bad-id", text: " " }]) expect((await route[method](request(body), context())).status).toBe(400);
    }
    mocks.getCollection.mockRejectedValue(new Error("sensitive database connection"));
    const response = await commentsRoute.GET(request(), context());
    expect(response.status).toBe(500);
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
    expect(JSON.stringify(await response.json())).not.toContain("sensitive");
  });
});
