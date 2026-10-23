import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { MongoClient, ObjectId } from "mongodb";
import { MongoMemoryReplSet, MongoMemoryServer } from "mongodb-memory-server-core";
import { createTreatmentPlan } from "@/lib/treatmentPlans";
import { getAdminCustomerProfile, getAdminCustomerPlans } from "@/lib/adminCustomerProfile";
import { sendDueFeedbackRequests } from "@/lib/appointmentFeedback";

vi.mock("@/lib/db", () => { throw new Error("Production database forbidden in deletion tests."); });
vi.mock("@/lib/whatsapp", () => { throw new Error("Real messaging forbidden in deletion tests."); });
const deletion = await import("@/lib/treatmentPlanDeletion").catch(() => ({}));
const comments = await import("@/lib/treatmentPlanComments").catch(() => ({}));
const NOW = new Date("2026-10-23T15:00:00Z");
const oid = (value) => new ObjectId(value.toString(16).padStart(24, "0"));
const userId = oid(1), planId = oid(10), otherUserId = oid(2);
const rows = [11, 12].map((n) => ({ _id: oid(n), date: "2026-11-20", time: n === 11 ? "10:00" : "11:00", title: "جلسة", duration: 60, price: 180 }));
let server, client, db, plan, count = 0;
beforeAll(async () => {
  server = await MongoMemoryReplSet.create({ instanceOpts: [{ launchTimeout: 120_000 }], replSet: { count: 1, ip: "127.0.0.1", storageEngine: "wiredTiger", spawn: { windowsHide: true } } });
  const uri = server.getUri();
  if (!uri.startsWith("mongodb://127.0.0.1:")) throw new Error("Loopback Mongo only");
  client = await new MongoClient(uri).connect();
}, 120_000);
afterAll(async () => { try { await client?.close(); } finally { await server?.stop(); } }, 120_000);
beforeEach(async () => {
  db = client.db(`plan_delete_${++count}`);
  plan = { _id: planId, userId, requestId: randomUUID(), createdAt: NOW, phone: "+972521234567", customerName: "اسم", schedule: "PRIVATE_SCHEDULE", payloadHash: "PRIVATE_HASH", notification: { status: "sent" }, appointments: rows,
    commentsVersion: 1, adminComments: [{ _id: randomUUID(), text: "PRIVATE_ADMIN_COMMENT", revision: 1, createdAt: NOW, updatedAt: NOW }] };
  await db.collection("usersData").insertOne({ _id: userId, phone: plan.phone, appointments: [], notes: [] });
  await db.collection("treatmentPlans").insertOne(plan);
  await db.collection("appointmentFeedback").insertMany(rows.map((a) => ({ _id: a._id, userId, appointmentId: a._id, tokenHash: "private", feedback: { text: "private feedback" } })));
});
const remove = (overrides = {}, deps = {}) => deletion.deleteCanceledTreatmentPlan({ userId: String(userId), planId: String(planId), ...overrides }, { db, client, now: NOW, ...deps });
const feedbackEnv = { FEEDBACK_REQUESTS_ENABLED: "true", FEEDBACK_PUBLIC_BASE_URL: "https://clinic.example", TWILIO_TEMPLATE_SOUL_TREATMENT_FEEDBACK: "HXtest", CRON_SECRET: "test", TWILIO_ACCOUNT_SID: "ACtest", TWILIO_AUTH_TOKEN: "test", TWILIO_WHATSAPP_FROM: "whatsapp:+14155238886" };
function deferred() { let resolve; const promise = new Promise((done) => { resolve = done; }); return { promise, resolve }; }
async function attendedPlanSession() {
  await db.collection("appointmentFeedback").deleteMany({});
  await db.collection("usersData").updateOne({ _id: userId }, { $set: { appointments: [{ ...rows[0], date: "2026-10-16", treatmentPlanId: planId, attended: true }] } });
}

describe("permanent deletion of fully canceled programs", () => {
  it("removes the snapshot and owned feedback, including recovered history, without touching other bookings", async () => {
    expect(deletion.deleteCanceledTreatmentPlan).toBeTypeOf("function");
    const unrelated = { ...rows[0], _id: oid(99) };
    await db.collection("appointments").insertOne({ date: unrelated.date, appointments: [{ _id: unrelated._id, time: unrelated.time }] });
    await db.collection("usersData").insertOne({ _id: otherUserId, appointments: [unrelated] });
    await db.collection("appointmentFeedback").insertOne({ _id: oid(98), userId: otherUserId, appointmentId: unrelated._id, feedback: { text: "keep" } });
    expect((await getAdminCustomerProfile(String(userId), { db, now: NOW })).appointments).toHaveLength(2);
    expect(await remove()).toEqual({ success: true, deleted: true });
    expect(await db.collection("treatmentPlans").findOne({ _id: planId })).toBeNull();
    expect(await db.collection("appointmentFeedback").countDocuments({ userId })).toBe(0);
    expect(await db.collection("appointmentFeedback").countDocuments({ userId: otherUserId })).toBe(1);
    expect((await db.collection("usersData").findOne({ _id: otherUserId })).appointments).toHaveLength(1);
    expect((await db.collection("appointments").findOne({ date: unrelated.date })).appointments).toHaveLength(1);
    expect((await getAdminCustomerProfile(String(userId), { db, now: NOW })).appointments).toEqual([]);
    const guard = await db.collection("deletedTreatmentPlanRequests").findOne({ _id: plan.requestId });
    expect(guard).toMatchObject({ userId, planId, createdAt: NOW, deletedAt: NOW });
    expect(Object.keys(guard).sort()).toEqual(["_id", "userId", "planId", "createdAt", "deletedAt"].sort());
    expect(JSON.stringify(guard)).not.toContain("PRIVATE_ADMIN_COMMENT");
    expect(JSON.stringify(guard)).not.toContain(plan.adminComments[0]._id);
  });

  it("removes all admin comments with a deleted program and refuses later comment writes", async () => {
    expect(comments.addTreatmentPlanComment).toBeTypeOf("function");
    const input = { userId: String(userId), planId: String(planId), commentId: randomUUID(), text: "تعليق إضافي" };
    await comments.addTreatmentPlanComment(input, { db, now: NOW });
    expect((await db.collection("treatmentPlans").findOne({ _id: planId })).adminComments).toHaveLength(2);
    await comments.deleteTreatmentPlanComment({ ...input, commentId: plan.adminComments[0]._id, revision: 1 }, { db, now: NOW });
    expect((await db.collection("treatmentPlans").findOne({ _id: planId })).deletedCommentIds).toContain(plan.adminComments[0]._id);
    await remove();
    expect(await db.collection("treatmentPlans").countDocuments({ "adminComments.text": { $exists: true } })).toBe(0);
    await expect(comments.addTreatmentPlanComment({ ...input, commentId: randomUUID() }, { db, now: NOW })).rejects.toMatchObject({ status: 404 });
    await expect(comments.updateTreatmentPlanComment({ ...input, revision: 1 }, { db, now: NOW })).rejects.toMatchObject({ status: 404 });
    expect(await db.collection("treatmentPlans").countDocuments()).toBe(0);
  });

  it("deletes comments committed after a program deletion has read its initial snapshot", async () => {
    expect(comments.addTreatmentPlanComment).toBeTypeOf("function");
    const deletionRead = deferred(), resumeDeletion = deferred();
    let paused = false;
    const deletingDb = { collection(name) {
      const target = db.collection(name);
      if (name !== "treatmentPlans") return target;
      return new Proxy(target, { get(collection, key) {
        if (key === "findOne") return async (...args) => {
          const result = await collection.findOne(...args);
          if (!paused && args[1]?.session) { paused = true; deletionRead.resolve(); await resumeDeletion.promise; }
          return result;
        };
        return typeof collection[key] === "function" ? collection[key].bind(collection) : collection[key];
      } });
    } };
    const removing = remove({}, { db: deletingDb });
    await deletionRead.promise;
    try {
      await comments.addTreatmentPlanComment({ userId: String(userId), planId: String(planId), commentId: randomUUID(), text: "تعليق أثناء الحذف" }, { db, now: NOW });
    } finally { resumeDeletion.resolve(); }
    await removing;
    expect(await db.collection("treatmentPlans").countDocuments()).toBe(0);
    expect(await db.collection("deletedTreatmentPlanRequests").countDocuments()).toBe(1);
  });

  it.each(["live history", "attended history", "calendar only", "foreign history", "plan-linked row"])("refuses deletion with %s still present", async (kind) => {
    expect(deletion.deleteCanceledTreatmentPlan).toBeTypeOf("function");
    if (kind === "calendar only") await db.collection("appointments").insertOne({ date: rows[0].date, appointments: [{ _id: rows[0]._id, time: rows[0].time }] });
    else if (kind === "foreign history") await db.collection("usersData").insertOne({ _id: otherUserId, appointments: [rows[0]] });
    else await db.collection("usersData").updateOne({ _id: userId }, { $set: { appointments: [{ ...rows[0],
      ...(kind === "attended history" ? { attended: true, date: "2026-10-01" } : {}),
      ...(kind === "plan-linked row" ? { _id: oid(999), treatmentPlanId: planId } : {}),
    }] } });
    await expect(remove()).rejects.toMatchObject({ status: 409, code: "PLAN_NOT_FULLY_CANCELED" });
    expect(await db.collection("treatmentPlans").countDocuments()).toBe(1);
    expect(await db.collection("appointmentFeedback").countDocuments()).toBe(2);
    expect(await db.collection("deletedTreatmentPlanRequests").countDocuments()).toBe(0);
  });

  it("rejects malformed/empty schedules and foreign owners without deleting data", async () => {
    expect(deletion.deleteCanceledTreatmentPlan).toBeTypeOf("function");
    await expect(remove({ userId: String(otherUserId) })).rejects.toMatchObject({ status: 404 });
    await db.collection("treatmentPlans").updateOne({ _id: planId }, { $set: { appointments: [] } });
    await expect(remove()).rejects.toMatchObject({ status: 409 });
    await db.collection("treatmentPlans").updateOne({ _id: planId }, { $set: { appointments: [{ ...rows[0], time: "bad" }] } });
    await expect(remove()).rejects.toMatchObject({ status: 409 });
    expect(await db.collection("treatmentPlans").countDocuments()).toBe(1);
  });

  it("handles repeated and simultaneous deletion without rebooking on an old save request", async () => {
    expect(deletion.deleteCanceledTreatmentPlan).toBeTypeOf("function");
    const outcomes = await Promise.all([remove(), remove(), remove()]);
    expect(outcomes.every((r) => r.success && r.deleted)).toBe(true);
    expect(await db.collection("deletedTreatmentPlanRequests").countDocuments()).toBe(1);
    const send = vi.fn();
    await expect(createTreatmentPlan({ userId: String(userId), requestId: plan.requestId, appointments: [{ treatmentId: String(oid(100)), serviceIndex: 0, expectedService: { title: "جلسة", duration: 60, price: 180 }, date: "2026-11-20", time: "10:00" }] }, { db, client, now: NOW, env: {}, sendTemplate: send })).rejects.toMatchObject({ status: 410, code: "TREATMENT_PLAN_DELETED" });
    expect(send).not.toHaveBeenCalled();
    expect(await db.collection("treatmentPlans").countDocuments()).toBe(0);
    expect(await db.collection("appointments").countDocuments()).toBe(0);
  });

  it("rolls back the marker and schedule if feedback removal fails", async () => {
    expect(deletion.deleteCanceledTreatmentPlan).toBeTypeOf("function");
    const brokenDb = { collection(name) {
      const collection = db.collection(name);
      return name === "appointmentFeedback" ? { deleteMany: async () => { throw new Error("injected failure"); } } : collection;
    } };
    await expect(remove({}, { db: brokenDb })).rejects.toBeDefined();
    expect(await db.collection("treatmentPlans").countDocuments()).toBe(1);
    expect(await db.collection("appointmentFeedback").countDocuments()).toBe(2);
    expect(await db.collection("deletedTreatmentPlanRequests").countDocuments()).toBe(0);
  });

  it("keeps pagination usable if another admin deletes its cursor program", async () => {
    expect(deletion.deleteCanceledTreatmentPlan).toBeTypeOf("function");
    await db.collection("treatmentPlans").insertOne({ ...plan, _id: oid(9), requestId: randomUUID(), createdAt: new Date("2026-10-22T10:00:00Z"), appointments: [{ ...rows[0], _id: oid(19) }] });
    await remove();
    const page = await getAdminCustomerPlans(String(userId), { db, now: NOW, cursor: String(planId) });
    expect(page.plans.map((p) => p._id)).toEqual([String(oid(9))]);
    await expect(getAdminCustomerPlans(String(otherUserId), { db, now: NOW, cursor: String(planId) })).rejects.toMatchObject({ status: 404 });
  });

  it("rejects bad IDs before touching storage", async () => {
    expect(deletion.deleteCanceledTreatmentPlan).toBeTypeOf("function");
    const isolated = { db: { collection: vi.fn() }, client: { startSession: vi.fn() } };
    await expect(remove({ planId: "bad" }, isolated)).rejects.toMatchObject({ status: 400 });
    await expect(remove({ userId: "bad" }, isolated)).rejects.toMatchObject({ status: 400 });
    expect(isolated.db.collection).not.toHaveBeenCalled();
    expect(isolated.client.startSession).not.toHaveBeenCalled();
  });

  it.each([false, true])("does not recreate feedback if cancellation/deletion races its claim (delete snapshot first: %s)", async (snapshotFirst) => {
    expect(deletion.deleteCanceledTreatmentPlan).toBeTypeOf("function");
    await attendedPlanSession();
    const ownedRead = deferred(), resumeWorker = deferred(), deletionRead = deferred(), resumeDeletion = deferred();
    const users = db.collection("usersData");
    let pausedWorker = false, pausedDeletion = false;
    const send = vi.fn(async () => ({ sid: "SMtest" }));
    const job = sendDueFeedbackRequests({ now: NOW }, { client, env: feedbackEnv, sendWhatsAppTemplate: send,
      getCollection: async (name) => name !== "usersData" ? db.collection(name) : new Proxy(users, { get(target, key) {
        if (key === "findOne") return async (...args) => {
          const result = await target.findOne(...args);
          if (!pausedWorker && result?.appointments?.[0]?.attended) { pausedWorker = true; ownedRead.resolve(); await resumeWorker.promise; }
          return result;
        };
        return typeof target[key] === "function" ? target[key].bind(target) : target[key];
      } }),
    });
    await ownedRead.promise;
    await users.updateOne({ _id: userId }, { $set: { appointments: [] } });
    let removing;
    if (snapshotFirst) {
      const deletingDb = { collection(name) {
        const target = db.collection(name);
        if (name !== "treatmentPlans") return target;
        return new Proxy(target, { get(collection, key) {
          if (key === "findOne") return async (...args) => {
            const result = await collection.findOne(...args);
            if (!pausedDeletion && args[1]?.session) { pausedDeletion = true; deletionRead.resolve(); await resumeDeletion.promise; }
            return result;
          };
          return typeof collection[key] === "function" ? collection[key].bind(collection) : collection[key];
        } });
      } };
      removing = remove({}, { db: deletingDb });
      await deletionRead.promise;
    } else await remove();
    resumeWorker.resolve();
    try {
      await job;
    } finally { resumeDeletion.resolve(); }
    if (removing) await removing;
    expect(send).not.toHaveBeenCalled();
    expect(await db.collection("treatmentPlans").countDocuments()).toBe(0);
    expect(await db.collection("appointmentFeedback").countDocuments()).toBe(0);
  }, 30_000);

  it("still claims a valid plan's feedback once and preserves ordinary feedback behavior", async () => {
    await attendedPlanSession();
    const send = vi.fn(async () => ({ sid: "SMtest" }));
    const deps = { client, env: feedbackEnv, getCollection: async (name) => db.collection(name), sendWhatsAppTemplate: send };
    expect((await sendDueFeedbackRequests({ now: NOW }, deps)).sent).toBe(1);
    expect((await sendDueFeedbackRequests({ now: NOW }, deps)).sent).toBe(0);
    expect(send).toHaveBeenCalledTimes(1);
    expect(await db.collection("appointmentFeedback").countDocuments()).toBe(1);
  });
});

it("requires transaction support and leaves standalone data intact", async () => {
  expect(deletion.deleteCanceledTreatmentPlan).toBeTypeOf("function");
  const standalone = await MongoMemoryServer.create({ instance: { ip: "127.0.0.1", launchTimeout: 120_000 }, spawn: { windowsHide: true } });
  let standaloneClient;
  try {
    const uri = standalone.getUri();
    if (!uri.startsWith("mongodb://127.0.0.1:")) throw new Error("Loopback only");
    standaloneClient = await new MongoClient(uri).connect();
    const standaloneDb = standaloneClient.db("deletion_standalone");
    await standaloneDb.collection("treatmentPlans").insertOne(plan);
    await expect(remove({}, { db: standaloneDb, client: standaloneClient })).rejects.toMatchObject({ status: 503, code: "TRANSACTIONS_REQUIRED" });
    expect(await standaloneDb.collection("treatmentPlans").countDocuments()).toBe(1);
  } finally { await standaloneClient?.close(); await standalone.stop(); }
}, 120_000);
