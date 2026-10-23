import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { MongoClient, ObjectId } from "mongodb";
import { MongoMemoryServer } from "mongodb-memory-server-core";
import { getAdminCustomerProfile, getAdminCustomerPlans } from "@/lib/adminCustomerProfile";

vi.mock("@/lib/db", () => { throw new Error("Production database access is forbidden in comment tests."); });
vi.mock("@/lib/whatsapp", () => { throw new Error("Messaging is forbidden in comment tests."); });
const comments = await import("@/lib/treatmentPlanComments").catch(() => ({}));
const userId = new ObjectId("000000000000000000000001");
const otherUserId = new ObjectId("000000000000000000000002");
const planId = new ObjectId("000000000000000000000010");
const now = new Date("2026-10-23T16:00:00Z");
const later = new Date("2026-10-23T16:05:00Z");
const identity = { userId: String(userId), planId: String(planId) };
let server, client, db, serial = 0;

beforeAll(async () => {
  server = await MongoMemoryServer.create({ instance: { ip: "127.0.0.1", launchTimeout: 120_000 }, spawn: { windowsHide: true } });
  const uri = server.getUri();
  if (!uri.startsWith("mongodb://127.0.0.1:")) throw new Error("Loopback database required.");
  client = await new MongoClient(uri).connect();
}, 120_000);
afterAll(async () => { try { await client?.close(); } finally { await server?.stop(); } }, 120_000);
beforeEach(async () => {
  db = client.db(`program_comments_${++serial}`);
  await db.collection("usersData").insertOne({ _id: userId, firstName: "عميل", appointments: [] });
  await db.collection("treatmentPlans").insertOne({ _id: planId, userId, createdAt: now, appointments: [],
    schedule: "PRIVATE_SCHEDULE", payloadHash: "PRIVATE_HASH", notification: { status: "sent", providerSid: "PRIVATE_PROVIDER" } });
});
const add = (commentId, text, extra = {}) => comments.addTreatmentPlanComment({ ...identity, commentId, text, ...extra }, { db, now });

describe("private program comments", () => {
  it("adds, edits and deletes independent plain-text comments with authoritative revisions and versions", async () => {
    expect(comments.addTreatmentPlanComment).toBeTypeOf("function");
    const firstId = randomUUID(), secondId = randomUUID();
    const text = "ملاحظة خاصة\n<script>plain text</script>";
    expect(await comments.getTreatmentPlanComments(identity, { db })).toEqual({ comments: [], commentsVersion: 0 });
    const first = await add(firstId, text);
    expect(first).toEqual({ success: true, commentsVersion: 1, comments: [{ _id: firstId, text, revision: 1,
      createdAt: "2026-10-23T16:00:00.000Z", updatedAt: "2026-10-23T16:00:00.000Z" }] });
    const second = await add(secondId, "تعليق ثانٍ");
    expect(second.comments.map((comment) => comment._id)).toEqual([firstId, secondId]);
    expect(second.commentsVersion).toBe(2);
    const edited = await comments.updateTreatmentPlanComment({ ...identity, commentId: firstId, text: "محدث\nبالتفصيل", revision: 1 }, { db, now: later });
    expect(edited.comments[0]).toEqual({ _id: firstId, text: "محدث\nبالتفصيل", revision: 2,
      createdAt: "2026-10-23T16:00:00.000Z", updatedAt: "2026-10-23T16:05:00.000Z" });
    expect(edited.comments[1]).toEqual(second.comments[1]);
    expect(edited.commentsVersion).toBe(3);
    const removed = await comments.deleteTreatmentPlanComment({ ...identity, commentId: firstId, revision: 2 }, { db });
    expect(removed).toEqual({ success: true, comments: [second.comments[1]], commentsVersion: 4 });
    expect(await comments.getTreatmentPlanComments(identity, { db })).toEqual({ comments: [second.comments[1]], commentsVersion: 4 });
    const stored = await db.collection("treatmentPlans").findOne({ _id: planId });
    expect(stored.adminComments).toHaveLength(1);
    expect(stored.adminComments[0].createdAt).toBeInstanceOf(Date);
    expect(stored.schedule).toBe("PRIVATE_SCHEDULE");
    expect(JSON.stringify(removed)).not.toMatch(/PRIVATE_|adminComments|userId|planId/);
  });

  it("deduplicates simultaneous add retries without losing independent additions", async () => {
    expect(comments.addTreatmentPlanComment).toBeTypeOf("function");
    const duplicateId = randomUUID();
    const ids = [duplicateId, duplicateId, ...Array.from({ length: 8 }, randomUUID)];
    await Promise.all(ids.map((commentId) => add(commentId, "تعليق")));
    const current = await comments.getTreatmentPlanComments(identity, { db });
    expect(current.comments).toHaveLength(9);
    expect(current.commentsVersion).toBe(9);
    expect(new Set(current.comments.map((comment) => comment._id)).size).toBe(9);
    expect(await add(duplicateId, "تعليق")).toEqual({ success: true, ...current });
    await expect(add(duplicateId, "مختلف")).rejects.toMatchObject({ status: 409, code: "COMMENT_ID_REUSED" });
  });

  it("rejects stale edits/deletes and allows only one concurrent edit of a revision", async () => {
    expect(comments.addTreatmentPlanComment).toBeTypeOf("function");
    const commentId = randomUUID();
    await add(commentId, "الأصل");
    const updates = await Promise.allSettled(["الأول", "الثاني"].map((text) => comments.updateTreatmentPlanComment({ ...identity, commentId, revision: 1, text }, { db, now: later })));
    expect(updates.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(updates.find((result) => result.status === "rejected").reason).toMatchObject({ status: 409, code: "COMMENT_CONFLICT" });
    await expect(comments.deleteTreatmentPlanComment({ ...identity, commentId, revision: 1 }, { db })).rejects.toMatchObject({ status: 409, code: "COMMENT_CONFLICT" });
    await expect(add(commentId, "الأصل")).rejects.toMatchObject({ status: 409, code: "COMMENT_ID_REUSED" });
    const current = await comments.getTreatmentPlanComments(identity, { db });
    expect(current.commentsVersion).toBe(2);
    expect(current.comments[0].revision).toBe(2);
  });

  it("never recreates a deleted UUID on a delayed add retry or accepts its stale revision", async () => {
    const commentId = randomUUID();
    await add(commentId, "تعليق أزيل");
    await comments.deleteTreatmentPlanComment({ ...identity, commentId, revision: 1 }, { db });
    await expect(add(commentId, "تعليق أزيل")).rejects.toMatchObject({ status: 409, code: "COMMENT_ID_REUSED" });
    await expect(comments.updateTreatmentPlanComment({ ...identity, commentId, revision: 1, text: "تعديل قديم" }, { db, now }))
      .rejects.toMatchObject({ status: 404, code: "COMMENT_NOT_FOUND" });

    const replacementId = randomUUID();
    const replacement = await add(replacementId, "تعليق جديد");
    expect(replacement.comments.map((comment) => comment._id)).toEqual([replacementId]);
    expect(replacement.commentsVersion).toBe(3);
    const stored = await db.collection("treatmentPlans").findOne({ _id: planId });
    expect(stored.deletedCommentIds).toEqual([commentId]);
    const current = await comments.getTreatmentPlanComments(identity, { db });
    const profile = await getAdminCustomerProfile(String(userId), { db, now });
    const page = await getAdminCustomerPlans(String(userId), { db, now });
    for (const result of [replacement, current, profile, page]) {
      expect(JSON.stringify(result)).not.toContain("deletedCommentIds");
      expect(JSON.stringify(result)).not.toContain(commentId);
      expect(JSON.stringify(result)).not.toContain("تعليق أزيل");
    }
  });

  it("enforces the comment cap atomically but permits an existing add retry at the cap", async () => {
    expect(comments.addTreatmentPlanComment).toBeTypeOf("function");
    const initial = Array.from({ length: 99 }, () => ({ _id: randomUUID(), text: "ملاحظة", revision: 1, createdAt: now, updatedAt: now }));
    await db.collection("treatmentPlans").updateOne({ _id: planId }, { $set: { adminComments: initial, commentsVersion: 99 } });
    const attempts = await Promise.allSettled([add(randomUUID(), "الأول"), add(randomUUID(), "الثاني")]);
    expect(attempts.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(attempts.find((result) => result.status === "rejected").reason).toMatchObject({ status: 409, code: "COMMENT_LIMIT_REACHED" });
    const retry = await add(initial[0]._id, "ملاحظة");
    expect(retry.comments).toHaveLength(100);
    expect(retry.commentsVersion).toBe(100);
  });

  it.each([
    ["user ID", { userId: "bad" }, "INVALID_USER_ID"], ["plan ID", { planId: "bad" }, "INVALID_PLAN_ID"],
    ["comment ID", { commentId: "bad" }, "INVALID_COMMENT_ID"], ["blank text", { text: " \n " }, "INVALID_COMMENT_TEXT"],
    ["long text", { text: "a".repeat(10001) }, "INVALID_COMMENT_TEXT"], ["object text", { text: { $set: "bad" } }, "INVALID_COMMENT_TEXT"],
  ])("validates %s before storage", async (_label, overrides, code) => {
    expect(comments.addTreatmentPlanComment).toBeTypeOf("function");
    const isolated = { collection: vi.fn() };
    await expect(comments.addTreatmentPlanComment({ ...identity, commentId: randomUUID(), text: "تعليق", ...overrides }, { db: isolated, now })).rejects.toMatchObject({ status: 400, code });
    expect(isolated.collection).not.toHaveBeenCalled();
  });

  it.each([0, -1, 1.2, "1", Number.MAX_SAFE_INTEGER])("rejects invalid revision %j before storage", async (revision) => {
    expect(comments.updateTreatmentPlanComment).toBeTypeOf("function");
    const isolated = { collection: vi.fn() };
    const input = { ...identity, commentId: randomUUID(), text: "تعليق", revision };
    await expect(comments.updateTreatmentPlanComment(input, { db: isolated, now })).rejects.toMatchObject({ status: 400, code: "INVALID_COMMENT_REVISION" });
    await expect(comments.deleteTreatmentPlanComment(input, { db: isolated })).rejects.toMatchObject({ status: 400, code: "INVALID_COMMENT_REVISION" });
    expect(isolated.collection).not.toHaveBeenCalled();
  });

  it("accepts 10000 characters without transforming markup, whitespace or line breaks", async () => {
    expect(comments.addTreatmentPlanComment).toBeTypeOf("function");
    const text = "  <p>\n" + "x".repeat(9992) + "  ";
    expect(text).toHaveLength(10000);
    expect((await add(randomUUID(), text)).comments[0].text).toBe(text);
  });

  it("scopes every operation to the owner and never upserts a missing program", async () => {
    expect(comments.addTreatmentPlanComment).toBeTypeOf("function");
    const commentId = randomUUID();
    await add(commentId, "خاصة");
    const foreign = { ...identity, userId: String(otherUserId), commentId, text: "تغيير", revision: 1 };
    for (const name of ["getTreatmentPlanComments", "addTreatmentPlanComment", "updateTreatmentPlanComment", "deleteTreatmentPlanComment"]) {
      await expect(comments[name](foreign, { db, now })).rejects.toMatchObject({ status: 404, code: "PLAN_NOT_FOUND" });
    }
    expect((await comments.getTreatmentPlanComments(identity, { db })).comments[0].text).toBe("خاصة");
    const absentComment = { ...identity, commentId: randomUUID(), text: "تغيير", revision: 1 };
    await expect(comments.updateTreatmentPlanComment(absentComment, { db, now })).rejects.toMatchObject({ status: 404, code: "COMMENT_NOT_FOUND" });
    await expect(comments.deleteTreatmentPlanComment(absentComment, { db })).rejects.toMatchObject({ status: 404, code: "COMMENT_NOT_FOUND" });
    const missingPlan = { ...identity, planId: String(new ObjectId()), commentId, text: "تعليق", revision: 1 };
    await expect(comments.addTreatmentPlanComment(missingPlan, { db, now })).rejects.toMatchObject({ status: 404, code: "PLAN_NOT_FOUND" });
    expect(await db.collection("treatmentPlans").countDocuments()).toBe(1);
  });

  it("includes only sanitized comments in both initial and paginated admin program projections", async () => {
    expect(comments.addTreatmentPlanComment).toBeTypeOf("function");
    const commentId = randomUUID();
    await add(commentId, "خاص بالإدارة");
    await db.collection("treatmentPlans").updateOne({ _id: planId }, { $set: { "adminComments.0.secret": "PRIVATE_EXTRA" } });
    const first = await getAdminCustomerProfile(String(userId), { db, now });
    const page = await getAdminCustomerPlans(String(userId), { db, now });
    const expected = [{ _id: commentId, text: "خاص بالإدارة", revision: 1,
      createdAt: "2026-10-23T16:00:00.000Z", updatedAt: "2026-10-23T16:00:00.000Z" }];
    expect(first.plans[0]).toMatchObject({ comments: expected, commentsVersion: 1 });
    expect(page.plans[0]).toMatchObject({ comments: expected, commentsVersion: 1 });
    expect(JSON.stringify(first)).not.toMatch(/PRIVATE_|adminComments/);
    expect(JSON.stringify(page)).not.toMatch(/PRIVATE_|adminComments/);
  });
});
