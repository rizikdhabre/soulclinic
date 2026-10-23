import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { MongoClient, ObjectId } from "mongodb";
import { MongoMemoryServer } from "mongodb-memory-server-core";
import * as profile from "@/lib/adminCustomerProfile";

vi.mock("@/lib/db", () => { throw new Error("Production database access is forbidden in profile pagination tests."); });
vi.mock("@/lib/whatsapp", () => { throw new Error("Messaging is forbidden in profile pagination tests."); });

const oid = (value) => new ObjectId(value.toString(16).padStart(24, "0"));
const userId = oid(1);
const otherUserId = oid(2);
const now = new Date("2026-10-23T10:00:00Z");
let server, client, db;
let serial = 0;

beforeAll(async () => {
  server = await MongoMemoryServer.create({ instance: { ip: "127.0.0.1", storageEngine: "wiredTiger", launchTimeout: 120_000 }, spawn: { windowsHide: true } });
  const uri = server.getUri();
  if (!uri.startsWith("mongodb://127.0.0.1:")) throw new Error("Test database must be loopback only.");
  client = await new MongoClient(uri).connect();
}, 120_000);
afterAll(async () => { try { await client?.close(); } finally { await server?.stop(); } }, 120_000);

function plan(number, createdDay, owner = userId) {
  return { _id: oid(number), userId: owner, createdAt: new Date(`2026-10-${createdDay}T10:00:00Z`),
    notification: { status: "sent", providerSid: "PRIVATE_PROVIDER" }, payloadHash: "PRIVATE_HASH",
    appointments: [{ _id: oid(number + 1000), date: "2026-11-20", time: "14:00", title: `علاج ${number}`, price: 180 }] };
}

beforeEach(async () => {
  db = client.db(`profile_pages_${++serial}`);
  await db.collection("usersData").insertOne({ _id: userId, firstName: "عميل", phone: "+972521234567", appointments: [], notes: [] });
  // IDs intentionally disagree with creation dates; tied dates require an ID tie-breaker.
  await db.collection("treatmentPlans").insertMany([
    plan(101, "10"), plan(102, "15"), plan(103, "16"), plan(104, "17"),
    plan(105, "14"), plan(106, "14"), plan(107, "14"), plan(199, "22", otherUserId),
  ]);
});

describe("customer program pagination", () => {
  it("returns only the latest three programs while preserving every recoverable appointment", async () => {
    const result = await profile.getAdminCustomerProfile(String(userId), { db, now });
    expect(result.plans.map((p) => p._id)).toEqual([104, 103, 102].map((n) => String(oid(n))));
    expect(result.plansPagination).toEqual({ hasMore: true, nextCursor: String(oid(102)) });
    expect(result.appointments).toHaveLength(7);
    expect(result.appointments.every((a) => a.status === "canceled")).toBe(true);
  });

  it("pages 3, 3, 1 with stable tied dates and no duplicates even if a new plan is inserted", async () => {
    expect(profile.getAdminCustomerPlans).toBeTypeOf("function");
    const first = await profile.getAdminCustomerPlans(String(userId), { db, now });
    expect(first.plans.map((p) => p._id)).toEqual([104, 103, 102].map((n) => String(oid(n))));
    await db.collection("treatmentPlans").insertOne(plan(108, "18"));
    const second = await profile.getAdminCustomerPlans(String(userId), { db, now, cursor: first.plansPagination.nextCursor });
    expect(second.plans.map((p) => p._id)).toEqual([107, 106, 105].map((n) => String(oid(n))));
    expect(second.plansPagination).toEqual({ hasMore: true, nextCursor: String(oid(105)) });
    const third = await profile.getAdminCustomerPlans(String(userId), { db, now, cursor: second.plansPagination.nextCursor });
    expect(third.plans.map((p) => p._id)).toEqual([String(oid(101))]);
    expect(third.plansPagination).toEqual({ hasMore: false, nextCursor: null });
    const repeat = await profile.getAdminCustomerPlans(String(userId), { db, now, cursor: first.plansPagination.nextCursor });
    expect(repeat).toEqual(second);
    expect(Object.keys(second).sort()).toEqual(["plans", "plansPagination"]);
    expect(JSON.stringify(second)).not.toMatch(/PRIVATE_PROVIDER|PRIVATE_HASH|علاج 199/);
    const refreshed = await profile.getAdminCustomerProfile(String(userId), { db, now });
    expect(refreshed.plans.map((p) => p._id)).toEqual([108, 104, 103].map((n) => String(oid(n))));
  });

  it("enriches a later page with current session times and uncertain/canceled/attended states", async () => {
    expect(profile.getAdminCustomerPlans).toBeTypeOf("function");
    const live = { _id: oid(1107), date: "2026-11-20", time: "16:00", title: "العلاج الحالي", price: 220, attended: false };
    const attended = { _id: oid(1106), date: "2026-10-20", time: "12:00", title: "جلسة سابقة", price: 160, attended: true };
    await db.collection("usersData").updateOne({ _id: userId }, { $set: { appointments: [live, attended] } });
    await db.collection("appointments").insertOne({ date: live.date, appointments: [{ _id: live._id, time: live.time }] });
    const result = await profile.getAdminCustomerPlans(String(userId), { db, now, cursor: String(oid(102)) });
    expect(result.plans.map((p) => p.status)).toEqual(["upcoming", "completed", "canceled"]);
    expect(result.plans[0].appointments[0]).toMatchObject({ time: "16:00", title: "العلاج الحالي", price: 220, status: "upcoming" });
    await db.collection("appointments").updateOne({ date: live.date }, { $set: { "appointments.0.time": "17:00" } });
    const conflicting = await profile.getAdminCustomerPlans(String(userId), { db, now, cursor: String(oid(102)) });
    expect(conflicting.plans[0].status).toBe("unknown");
  });

  it("hides the next-page cursor for exactly three or zero programs", async () => {
    expect(profile.getAdminCustomerPlans).toBeTypeOf("function");
    await db.collection("treatmentPlans").deleteMany({ userId, _id: { $nin: [oid(104), oid(103), oid(102)] } });
    expect((await profile.getAdminCustomerProfile(String(userId), { db, now })).plansPagination).toEqual({ hasMore: false, nextCursor: null });
    const three = await profile.getAdminCustomerPlans(String(userId), { db, now });
    expect(three.plans).toHaveLength(3);
    expect(three.plansPagination).toEqual({ hasMore: false, nextCursor: null });
    await db.collection("treatmentPlans").deleteMany({ userId });
    expect(await profile.getAdminCustomerPlans(String(userId), { db, now })).toEqual({ plans: [], plansPagination: { hasMore: false, nextCursor: null } });
  });

  it.each(["bad", "a".repeat(25), { $gt: "" }])("rejects malformed cursors before database access: %j", async (cursor) => {
    expect(profile.getAdminCustomerPlans).toBeTypeOf("function");
    const fakeDb = { collection: vi.fn() };
    await expect(profile.getAdminCustomerPlans(String(userId), { db: fakeDb, cursor })).rejects.toMatchObject({ status: 400, code: "INVALID_CURSOR" });
    expect(fakeDb.collection).not.toHaveBeenCalled();
  });

  it("rejects a cursor belonging to another customer and handles missing customers safely", async () => {
    expect(profile.getAdminCustomerPlans).toBeTypeOf("function");
    await expect(profile.getAdminCustomerPlans(String(userId), { db, now, cursor: String(oid(199)) })).rejects.toMatchObject({ status: 400, code: "INVALID_CURSOR" });
    await expect(profile.getAdminCustomerPlans(String(oid(999)), { db, now })).rejects.toMatchObject({ status: 404, code: "USER_NOT_FOUND" });
    await expect(profile.getAdminCustomerPlans("bad", { db, now })).rejects.toMatchObject({ status: 400, code: "INVALID_USER_ID" });
  });
});
