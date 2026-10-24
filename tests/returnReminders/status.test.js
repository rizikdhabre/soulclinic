import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { MongoClient, ObjectId } from "mongodb";
import { MongoMemoryServer } from "mongodb-memory-server-core";

const mocks = vi.hoisted(() => ({ verify: vi.fn(), getCollection: vi.fn() }));
vi.mock("@/lib/jwt", () => ({ verifyToken: mocks.verify }));
vi.mock("@/lib/db", () => ({ getCollection: mocks.getCollection }));
const service = await import("@/lib/returnReminderStatus").catch(() => ({}));
const route = await import("@/app/api/admin/users/[userId]/return-reminders/status/route").catch(() => ({}));
const PHONE = "+972521234567";
const USER_ID = new ObjectId("000000000000000000000011");
const NOW = new Date("2026-10-24T15:00:00.000Z");
const appointment = (extra = {}) => ({ _id: new ObjectId(), date: "2026-07-24", time: "12:00", attended: true, ...extra });
const request = (token = "admin") => ({ cookies: { get: () => token ? { value: token } : undefined } });
const context = (userId = String(USER_ID)) => ({ params: Promise.resolve({ userId }) });
let server, client, db, deps;
beforeAll(async () => {
  server = await MongoMemoryServer.create({ instance: { ip: "127.0.0.1", launchTimeout: 120_000 }, spawn: { windowsHide: true } });
  const uri = server.getUri();
  if (!uri.startsWith("mongodb://127.0.0.1:")) throw new Error("Expected loopback test MongoDB");
  client = new MongoClient(uri, { monitorCommands: true });
  await client.connect();
  db = client.db("return_reminder_status_test");
}, 120_000);
afterAll(async () => { await client?.close(); await server?.stop(); });
beforeEach(async () => {
  vi.resetAllMocks();
  await db.dropDatabase();
  mocks.verify.mockReturnValue({ role: "admin", adminId: "verified-admin" });
  mocks.getCollection.mockImplementation(async name => db.collection(name));
  deps = { getCollection: async name => db.collection(name) };
  await db.collection("usersData").insertOne({ _id: USER_ID, phone: "052-123-4567", appointments: [appointment()] });
});
const status = (now = NOW) => service.getReturnReminderStatus({ phone: PHONE, now }, deps);

describe("private return reminder status", () => {
  it("estimates the next daily clinic opportunity and returns only safe attendance fields without writes", async () => {
    expect(service.getReturnReminderStatus).toBeTypeOf("function");
    const writes = [];
    const listener = event => { if (["insert", "update", "findAndModify", "delete"].includes(event.commandName)) writes.push(event.commandName); };
    client.on("commandStarted", listener);
    let result;
    try { result = await status(); } finally { client.off("commandStarted", listener); }
    expect(result).toEqual({ lastAttended: { date: "2026-07-24", time: "12:00" }, lastAttemptAt: null, nextReminderAt: "2026-10-24T16:00:00.000Z", status: "scheduled" });
    expect(writes).toEqual([]);
    expect(await db.collection("returnReminderSettings").countDocuments()).toBe(0);
  });

  it("moves a passed 19:00 opportunity to the next Israel day across the DST change", async () => {
    expect(service.getReturnReminderStatus).toBeTypeOf("function");
    expect(await status(new Date("2026-10-24T16:00:00.000Z"))).toMatchObject({ nextReminderAt: "2026-10-24T16:00:00.000Z", status: "scheduled" });
    expect(await status(new Date("2026-10-24T16:00:00.001Z"))).toMatchObject({ nextReminderAt: "2026-10-25T17:00:00.000Z", status: "scheduled" });
  });

  it("uses latest attended care across duplicate profiles and ignores later historical no-shows", async () => {
    expect(service.getReturnReminderStatus).toBeTypeOf("function");
    await db.collection("usersData").insertMany([
      { phone: "00972 52 123 4567", appointments: [appointment({ date: "2026-08-25" }), appointment({ date: "2026-10-23", attended: false })] },
      { phone: Number("972521234567"), appointments: [appointment({ date: "2026-08-26" })] },
      { phone: "+972509999999", appointments: [appointment({ date: "2026-10-24", time: "20:00", attended: false })] },
    ]);
    expect(await status()).toMatchObject({ lastAttended: { date: "2026-08-26", time: "12:00" }, nextReminderAt: "2026-11-26T17:00:00.000Z", status: "scheduled" });
  });

  it("uses the current custom inactivity rule while comments stay private", async () => {
    expect(service.getReturnReminderStatus).toBeTypeOf("function");
    await db.collection("usersData").updateOne({ _id: USER_ID }, { $set: { appointments: [appointment({ date: "2026-10-20" })] } });
    await db.collection("returnReminderSettings").insertOne({ _id: PHONE, schedule: { mode: "custom", value: 10, unit: "days" }, scheduleRevision: 2, adminComments: [{ text: "Private comment" }] });
    const result = await status();
    expect(result).toMatchObject({ nextReminderAt: "2026-10-30T17:00:00.000Z", status: "scheduled" });
    expect(JSON.stringify(result)).not.toContain("Private comment");
  });

  it("recalculates a completed attempt under the current rule and uses dispatch time for last attempt", async () => {
    expect(service.getReturnReminderStatus).toBeTypeOf("function");
    const attemptId = new ObjectId();
    await db.collection("returnReminderSettings").insertOne({ _id: PHONE, schedule: { mode: "custom", value: 2, unit: "months" }, scheduleRevision: 3 });
    await db.collection("returnReminderState").insertOne({ _id: PHONE, attemptId, claimedAt: new Date("2026-10-15T09:00:00Z"), dispatchStartedAt: new Date("2026-10-15T10:00:00Z"), nextAttemptAt: new Date("2027-01-01") });
    await db.collection("returnReminderHistory").insertOne({ _id: attemptId, phone: PHONE, dispatch: { status: "sent", completedAt: new Date("2026-10-15T10:01:00Z") }, tokenHash: "private" });
    expect(await status()).toMatchObject({ lastAttemptAt: "2026-10-15T10:00:00.000Z", nextReminderAt: "2026-12-15T17:00:00.000Z", status: "scheduled" });
  });

  it("retains an unresolved attempt reservation and chooses the following evening when it expires after 19:00", async () => {
    expect(service.getReturnReminderStatus).toBeTypeOf("function");
    const attemptId = new ObjectId();
    await db.collection("returnReminderState").insertOne({ _id: PHONE, attemptId, claimedAt: new Date("2026-10-15T10:00:00Z"), nextAttemptAt: new Date("2026-11-05T19:30:00Z") });
    await db.collection("returnReminderHistory").insertOne({ _id: attemptId, phone: PHONE, dispatch: { status: "claimed" } });
    expect(await status()).toMatchObject({ lastAttemptAt: "2026-10-15T10:00:00.000Z", nextReminderAt: "2026-11-06T17:00:00.000Z", status: "scheduled" });
  });

  it.each(["profile", "calendar"])("pauses for an upcoming %s booking on a phone alias", async source => {
    expect(service.getReturnReminderStatus).toBeTypeOf("function");
    if (source === "profile") await db.collection("usersData").insertOne({ phone: "00972521234567", appointments: [appointment({ date: "2026-12-01", attended: false })] });
    else await db.collection("appointments").insertOne({ date: "2026-12-01", appointments: [{ phone: "052 123 4567", time: "13:00" }] });
    expect(await status()).toMatchObject({ status: "upcoming", lastAttended: { date: "2026-07-24", time: "12:00" }, nextReminderAt: null });
  });

  it("shows disabled consent and never-attended status without a scheduled estimate", async () => {
    expect(service.getReturnReminderStatus).toBeTypeOf("function");
    await db.collection("returnReminderPreferences").insertOne({ _id: PHONE, enabled: false });
    expect(await status()).toMatchObject({ status: "disabled", nextReminderAt: null });
    await db.collection("returnReminderPreferences").deleteMany({});
    await db.collection("usersData").updateOne({ _id: USER_ID }, { $set: { appointments: [appointment({ attended: false })] } });
    expect(await status()).toEqual({ status: "no_attendance", lastAttended: null, lastAttemptAt: null, nextReminderAt: null });
  });

  it.each(["profile array", "invalid date", "attended time", "missing attendance ID", "future attended", "future time", "calendar date", "schedule", "state deadline", "invalid attempt", "future attempt", "history completion", "future completion", "history status"])("fails closed on unsafe %s data", async defect => {
    expect(service.getReturnReminderStatus).toBeTypeOf("function");
    if (defect === "profile array") await db.collection("usersData").updateOne({ _id: USER_ID }, { $set: { appointments: {} } });
    if (defect === "invalid date") await db.collection("usersData").updateOne({ _id: USER_ID }, { $push: { appointments: appointment({ date: "2026-02-30" }) } });
    if (defect === "attended time") await db.collection("usersData").updateOne({ _id: USER_ID }, { $push: { appointments: appointment({ time: "bad" }) } });
    if (defect === "missing attendance ID") await db.collection("usersData").updateOne({ _id: USER_ID }, { $push: { appointments: { date: "2026-10-20", time: "12:00", attended: true } } });
    if (defect === "future attended") await db.collection("usersData").updateOne({ _id: USER_ID }, { $push: { appointments: appointment({ date: "2026-12-01" }) } });
    if (defect === "future time") await db.collection("usersData").updateOne({ _id: USER_ID }, { $push: { appointments: appointment({ date: "2026-12-01", time: "bad", attended: false }) } });
    if (defect === "calendar date") await db.collection("appointments").insertOne({ date: "bad", appointments: [{ phone: PHONE, time: "12:00" }] });
    if (defect === "schedule") await db.collection("returnReminderSettings").insertOne({ _id: PHONE, schedule: { mode: "custom", value: 0, unit: "days" }, scheduleRevision: 1 });
    if (defect === "state deadline") await db.collection("returnReminderState").insertOne({ _id: PHONE, nextAttemptAt: "invalid" });
    if (defect === "invalid attempt") await db.collection("returnReminderState").insertOne({ _id: PHONE, claimedAt: "invalid", nextAttemptAt: new Date("2026-11-01") });
    if (defect === "future attempt") await db.collection("returnReminderState").insertOne({ _id: PHONE, claimedAt: new Date("2026-12-01"), nextAttemptAt: new Date("2027-01-01") });
    if (["history completion", "future completion", "history status"].includes(defect)) {
      const attemptId = new ObjectId();
      await db.collection("returnReminderState").insertOne({ _id: PHONE, attemptId, claimedAt: new Date("2026-10-15"), nextAttemptAt: new Date("2026-11-15") });
      const dispatch = defect === "history completion" ? { status: "sent", completedAt: "invalid" }
        : defect === "future completion" ? { status: "sent", completedAt: new Date("2026-12-01") } : { status: "malformed" };
      await db.collection("returnReminderHistory").insertOne({ _id: attemptId, phone: PHONE, dispatch });
    }
    expect(await status()).toMatchObject({ status: "unavailable", nextReminderAt: null });
  });

  it("allows malformed old no-show times without hiding valid attended history", async () => {
    expect(service.getReturnReminderStatus).toBeTypeOf("function");
    await db.collection("usersData").updateOne({ _id: USER_ID }, { $push: { appointments: appointment({ date: "2026-08-01", time: "bad", attended: false }) } });
    expect(await status()).toMatchObject({ status: "scheduled", nextReminderAt: "2026-10-24T16:00:00.000Z" });
  });
});

describe("admin return reminder status route", () => {
  it("requires admin authorization before database access with private no-store errors", async () => {
    expect(route.GET).toBeTypeOf("function");
    for (const [token, identity, code] of [[null, null, 401], ["invalid", null, 401], ["customer", { role: "customer" }, 403]]) {
      mocks.verify.mockReturnValue(identity);
      const response = await route.GET(request(token), context());
      expect(response.status).toBe(code);
      expect(response.headers.get("Cache-Control")).toBe("private, no-store");
      expect(mocks.getCollection).not.toHaveBeenCalled();
    }
  });

  it("resolves the server phone and returns only the status contract without caching", async () => {
    expect(route.GET).toBeTypeOf("function");
    const response = await route.GET(request(), context());
    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
    const body = await response.json();
    expect(Object.keys(body).sort()).toEqual(["lastAttemptAt", "lastAttended", "nextReminderAt", "status"]);
    expect(body.lastAttended).toEqual({ date: "2026-07-24", time: "12:00" });
    expect(body.status).toBe("scheduled");
  });

  it("rejects invalid or missing users and invalid phone data and sanitizes storage failures", async () => {
    expect(route.GET).toBeTypeOf("function");
    expect((await route.GET(request(), context("bad"))).status).toBe(400);
    expect((await route.GET(request(), context("000000000000000000000099"))).status).toBe(404);
    await db.collection("usersData").updateOne({ _id: USER_ID }, { $set: { phone: {} } });
    expect((await route.GET(request(), context())).status).toBe(400);
    mocks.getCollection.mockRejectedValue(new Error("private connection"));
    const response = await route.GET(request(), context());
    expect(response.status).toBe(500);
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
    expect(JSON.stringify(await response.json())).not.toContain("private connection");
  });
});
