import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { MongoClient } from "mongodb";
import { MongoMemoryServer } from "mongodb-memory-server-core";

vi.mock("@/lib/db", () => ({ getCollection: () => { throw new Error("Application database access forbidden"); } }));
const service = await import("@/lib/returnReminderComments").catch(() => ({}));
const PHONE = "+972521234567";
const NOW = new Date("2026-10-24T12:00:00.000Z");
const ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const OTHER_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
let server, client, db, deps, records;
beforeAll(async () => {
  server = await MongoMemoryServer.create({ instance: { ip: "127.0.0.1", launchTimeout: 120_000 }, spawn: { windowsHide: true } });
  const uri = server.getUri();
  if (!uri.startsWith("mongodb://127.0.0.1:")) throw new Error("Expected loopback test MongoDB");
  client = new MongoClient(uri);
  await client.connect();
  db = client.db("return_reminder_comments_test");
}, 120_000);
afterAll(async () => { await client?.close(); await server?.stop(); });
beforeEach(async () => {
  await db.dropDatabase();
  records = db.collection("returnReminderSettings");
  deps = { getCollection: async (name) => db.collection(name), now: NOW };
});
const add = (input = {}) => service.addReturnReminderComment({ phone: PHONE, commentId: ID, text: "ملاحظة خاصة", adminId: "admin-1", ...input }, deps);

describe("private return reminder comments", () => {
  it("reads no comments without writing any document", async () => {
    expect(service.getReturnReminderComments).toBeTypeOf("function");
    expect(await service.getReturnReminderComments({ phone: PHONE }, deps)).toEqual({ comments: [], commentsVersion: 0 });
    expect(await records.countDocuments()).toBe(0);
  });

  it("stores multiple phone scoped comments with isolated comment revisions and safe projection", async () => {
    expect(service.addReturnReminderComment).toBeTypeOf("function");
    await add({ commentId: ID.toUpperCase() });
    await add({ phone: "0521234567", commentId: OTHER_ID, text: "Second comment" });
    const result = await service.getReturnReminderComments({ phone: "00972521234567" }, deps);
    expect(result).toEqual({ comments: [
      { _id: ID, text: "ملاحظة خاصة", revision: 1, createdAt: NOW.toISOString(), updatedAt: NOW.toISOString() },
      { _id: OTHER_ID, text: "Second comment", revision: 1, createdAt: NOW.toISOString(), updatedAt: NOW.toISOString() },
    ], commentsVersion: 2 });
    expect(await service.getReturnReminderComments({ phone: "0509999999" }, deps)).toEqual({ comments: [], commentsVersion: 0 });
    expect(await db.collection("treatmentPlans").countDocuments()).toBe(0);
    expect(await db.collection("returnReminderPreferences").countDocuments()).toBe(0);
  });

  it("deduplicates concurrent retry adds and prevents UUID reuse after editing or deleting", async () => {
    expect(service.addReturnReminderComment).toBeTypeOf("function");
    await Promise.all(Array.from({ length: 8 }, () => add()));
    expect(await service.getReturnReminderComments({ phone: PHONE }, deps)).toMatchObject({ comments: [{ _id: ID, revision: 1 }], commentsVersion: 1 });
    await expect(add({ text: "Different payload" })).rejects.toMatchObject({ status: 409, code: "COMMENT_ID_REUSED" });
    await service.updateReturnReminderComment({ phone: PHONE, commentId: ID, text: "Edited", revision: 1 }, deps);
    await expect(add()).rejects.toMatchObject({ status: 409, code: "COMMENT_ID_REUSED" });
    expect(await service.deleteReturnReminderComment({ phone: PHONE, commentId: ID, revision: 2 }, deps)).toEqual({ comments: [], commentsVersion: 3 });
    expect(await service.deleteReturnReminderComment({ phone: PHONE, commentId: ID, revision: 2 }, deps)).toEqual({ comments: [], commentsVersion: 3 });
    await expect(add()).rejects.toMatchObject({ status: 409, code: "COMMENT_ID_REUSED" });
    expect((await records.findOne({ _id: PHONE })).deletedCommentIds).toEqual([ID]);
  });

  it("rejects stale concurrent edits and deletes without overwriting comments or schedule fields", async () => {
    expect(service.addReturnReminderComment).toBeTypeOf("function");
    const scheduleFields = { schedule: { mode: "custom", value: 2, unit: "months" }, scheduleRevision: 7, scheduleUpdatedAt: NOW, scheduleUpdatedByAdminId: "schedule-admin" };
    await records.insertOne({ _id: PHONE, ...scheduleFields });
    await add();
    const writes = await Promise.allSettled([
      service.updateReturnReminderComment({ phone: PHONE, commentId: ID, text: "Edit one", revision: 1 }, deps),
      service.updateReturnReminderComment({ phone: PHONE, commentId: ID, text: "Edit two", revision: 1 }, deps),
    ]);
    expect(writes.filter(write => write.status === "fulfilled")).toHaveLength(1);
    expect(writes.find(write => write.status === "rejected").reason).toMatchObject({ status: 409, code: "COMMENT_CONFLICT" });
    await expect(service.deleteReturnReminderComment({ phone: PHONE, commentId: ID, revision: 1 }, deps)).rejects.toMatchObject({ status: 409 });
    expect(await records.findOne({ _id: PHONE })).toMatchObject(scheduleFields);
    expect((await service.getReturnReminderComments({ phone: PHONE }, deps)).commentsVersion).toBe(2);
  });

  it("keeps comments and tombstones when switching schedules, even during concurrent writes", async () => {
    expect(service.addReturnReminderComment).toBeTypeOf("function");
    const settings = await import("@/lib/returnReminderSettings");
    await add();
    await service.deleteReturnReminderComment({ phone: PHONE, commentId: ID, revision: 1 }, deps);
    await Promise.all([
      add({ commentId: OTHER_ID }),
      settings.setReturnReminderSettings({ phone: PHONE, schedule: { mode: "default" }, scheduleRevision: 0 }, deps),
    ]);
    expect(await records.findOne({ _id: PHONE })).toMatchObject({ schedule: { mode: "default" }, scheduleRevision: 1, deletedCommentIds: [ID], commentsVersion: 3 });
    expect((await service.getReturnReminderComments({ phone: PHONE }, deps)).comments).toHaveLength(1);
  });

  it("enforces the 100 comment capacity atomically", async () => {
    expect(service.addReturnReminderComment).toBeTypeOf("function");
    const existing = Array.from({ length: 99 }, (_, index) => ({ _id: `${index.toString(16).padStart(8, "0")}-0000-4000-8000-000000000000`, text: "Existing", revision: 1, createdAt: NOW, updatedAt: NOW }));
    await records.insertOne({ _id: PHONE, adminComments: existing, commentsVersion: 99 });
    const results = await Promise.allSettled([add(), add({ commentId: OTHER_ID })]);
    expect(results.filter(result => result.status === "fulfilled")).toHaveLength(1);
    expect(results.find(result => result.status === "rejected").reason).toMatchObject({ status: 409, code: "COMMENT_LIMIT_REACHED" });
    expect((await service.getReturnReminderComments({ phone: PHONE }, deps)).comments).toHaveLength(100);
  });

  it("validates phone, UUID, text and revisions before touching storage", async () => {
    expect(service.addReturnReminderComment).toBeTypeOf("function");
    const isolated = { getCollection: () => { throw new Error("Unexpected storage access"); } };
    for (const override of [{ phone: {} }, { commentId: undefined }, { commentId: "bad" }, { text: " " }, { text: [] }, { text: "x".repeat(10001) }]) {
      await expect(service.addReturnReminderComment({ phone: PHONE, commentId: ID, text: "Note", ...override }, isolated)).rejects.toMatchObject({ status: 400 });
    }
    for (const revision of [undefined, 0, -1, 1.5, "1", Number.MAX_SAFE_INTEGER]) await expect(service.deleteReturnReminderComment({ phone: PHONE, commentId: ID, revision }, isolated)).rejects.toMatchObject({ status: 400 });
    await expect(service.updateReturnReminderComment({ phone: PHONE, commentId: ID, revision: 1, text: "Missing" }, deps)).rejects.toMatchObject({ status: 404, code: "COMMENT_NOT_FOUND" });
    expect(await records.countDocuments()).toBe(0);
  });
});
