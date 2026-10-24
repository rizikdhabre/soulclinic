import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { MongoClient } from "mongodb";
import { MongoMemoryServer } from "mongodb-memory-server-core";
import { getReturnReminderPreference, setReturnReminderPreference } from "@/lib/returnReminderPreferences";

vi.mock("@/lib/db", () => ({ getCollection: () => { throw new Error("Application database access forbidden"); } }));
const settings = await import("@/lib/returnReminderSettings").catch(() => ({}));
const comments = await import("@/lib/returnReminderComments").catch(() => ({}));
const PHONE = "+972521234567";
const NOW = new Date("2026-10-24T12:00:00.000Z");
const COMMENT_ID = "11111111-1111-4111-8111-111111111111";
const CUSTOM = { mode: "custom", value: 45, unit: "days" };
let server, client, db, deps, records;

beforeAll(async () => {
  server = await MongoMemoryServer.create({ instance: { ip: "127.0.0.1", launchTimeout: 120_000 }, spawn: { windowsHide: true } });
  const uri = server.getUri();
  if (!uri.startsWith("mongodb://127.0.0.1:")) throw new Error("Expected loopback test MongoDB");
  client = new MongoClient(uri, { monitorCommands: true });
  await client.connect();
  db = client.db("return_reminder_settings_test");
}, 120_000);
afterAll(async () => { await client?.close(); await server?.stop(); });
beforeEach(async () => {
  await db.dropDatabase();
  records = db.collection("returnReminderSettings");
  deps = { getCollection: async (name) => db.collection(name), now: NOW };
});

describe("phone scoped return reminder schedules", () => {
  it("reads missing settings as default without creating settings or consent", async () => {
    expect(settings.getReturnReminderSettings).toBeTypeOf("function");
    expect(await settings.getReturnReminderSettings({ phone: "052-123-4567" }, deps)).toEqual({ schedule: { mode: "default" }, scheduleRevision: 0 });
    expect(await records.countDocuments()).toBe(0);
    expect(await db.collection("returnReminderPreferences").countDocuments()).toBe(0);
  });

  it.each([
    { mode: "default" }, { mode: "custom", value: 1, unit: "days" },
    { mode: "custom", value: 3650, unit: "days" }, { mode: "custom", value: 1, unit: "months" },
    { mode: "custom", value: 120, unit: "months" },
  ])("accepts the complete bounded schedule %j", (schedule) => {
    expect(settings.normalizeReturnReminderSchedule).toBeTypeOf("function");
    expect(settings.normalizeReturnReminderSchedule(schedule)).toEqual(schedule);
  });

  it.each([
    undefined, null, [], {}, "default", { mode: "weekly" }, { mode: "default", value: 1 },
    { mode: "custom", value: "1", unit: "days" }, { mode: "custom", value: 0, unit: "days" },
    { mode: "custom", value: -1, unit: "days" }, { mode: "custom", value: 1.5, unit: "days" },
    { mode: "custom", value: 3651, unit: "days" }, { mode: "custom", value: 121, unit: "months" },
    { mode: "custom", value: 1, unit: "weeks" }, { mode: "custom", value: 1, unit: "days", enabled: true },
  ])("rejects malformed schedules without coercion: %j", (schedule) => {
    expect(settings.normalizeReturnReminderSchedule).toBeTypeOf("function");
    expect(() => settings.normalizeReturnReminderSchedule(schedule)).toThrow(expect.objectContaining({ status: 400, code: "INVALID_RETURN_REMINDER_SCHEDULE" }));
  });

  it("shares one revision across phone aliases and restores default without touching consent", async () => {
    expect(settings.setReturnReminderSettings).toBeTypeOf("function");
    await setReturnReminderPreference({ phone: PHONE, enabled: false, source: "admin", adminId: "consent-admin", now: NOW }, deps);
    const before = await db.collection("returnReminderPreferences").findOne({ _id: PHONE });
    expect(await settings.setReturnReminderSettings({ phone: "0521234567", schedule: CUSTOM, scheduleRevision: 0, adminId: "schedule-admin" }, deps))
      .toEqual({ schedule: CUSTOM, scheduleRevision: 1 });
    expect(await settings.getReturnReminderSettings({ phone: "00972521234567" }, deps)).toEqual({ schedule: CUSTOM, scheduleRevision: 1 });
    expect(await settings.setReturnReminderSettings({ phone: PHONE, schedule: { mode: "default" }, scheduleRevision: 1, adminId: "second-admin" }, deps))
      .toEqual({ schedule: { mode: "default" }, scheduleRevision: 2 });
    expect(await records.countDocuments()).toBe(1);
    expect(await records.findOne({ _id: PHONE })).toMatchObject({ scheduleUpdatedAt: NOW, scheduleUpdatedByAdminId: "second-admin" });
    expect(await db.collection("returnReminderPreferences").findOne({ _id: PHONE })).toEqual(before);
    expect(await getReturnReminderPreference({ phone: PHONE }, deps)).toEqual({ enabled: false });
  });

  it("permits only one concurrent first save and one concurrent later save", async () => {
    expect(settings.setReturnReminderSettings).toBeTypeOf("function");
    for (const revision of [0, 1]) {
      const results = await Promise.allSettled(Array.from({ length: 8 }, (_, index) => settings.setReturnReminderSettings({ phone: PHONE, schedule: { mode: "custom", unit: "days", value: index + 1 }, scheduleRevision: revision }, deps)));
      expect(results.filter(result => result.status === "fulfilled")).toHaveLength(1);
      expect(results.filter(result => result.status === "rejected").every(result => result.reason.status === 409)).toBe(true);
      expect((await settings.getReturnReminderSettings({ phone: PHONE }, deps)).scheduleRevision).toBe(revision + 1);
    }
  });

  it("does not manufacture consent when concurrent schedule and comment writes create settings", async () => {
    expect(settings.setReturnReminderSettings).toBeTypeOf("function");
    expect(comments.addReturnReminderComment).toBeTypeOf("function");
    await Promise.all([
      settings.setReturnReminderSettings({ phone: PHONE, schedule: CUSTOM, scheduleRevision: 0, adminId: "schedule-admin" }, deps),
      comments.addReturnReminderComment({ phone: "0521234567", commentId: COMMENT_ID, text: "Private admin note", adminId: "comment-admin" }, deps),
    ]);
    const stored = await records.findOne({ _id: PHONE });
    expect(stored).toMatchObject({ schedule: CUSTOM, scheduleRevision: 1, scheduleUpdatedByAdminId: "schedule-admin", commentsVersion: 1 });
    expect(stored.adminComments).toHaveLength(1);
    expect(await db.collection("returnReminderPreferences").countDocuments()).toBe(0);
    expect(await getReturnReminderPreference({ phone: PHONE }, deps)).toEqual({ enabled: true });
  });

  it("reads only schedule fields and fails closed on malformed stored rules or revisions", async () => {
    expect(settings.getReturnReminderSettings).toBeTypeOf("function");
    const commands = [];
    const listener = event => { if (event.commandName === "find") commands.push(event.command); };
    client.on("commandStarted", listener);
    try { await settings.getReturnReminderSettings({ phone: PHONE }, deps); } finally { client.off("commandStarted", listener); }
    expect(commands).toHaveLength(1);
    expect(commands[0].projection).toEqual({ schedule: 1, scheduleRevision: 1 });
    expect(commands[0].readConcern).toEqual({ level: "majority" });
    for (const stored of [
      { schedule: null, scheduleRevision: 0 }, { schedule: { mode: "custom", value: 0, unit: "days" }, scheduleRevision: 1 },
      { schedule: CUSTOM, scheduleRevision: "1" }, { schedule: CUSTOM, scheduleRevision: -1 }, { schedule: CUSTOM },
    ]) {
      await records.replaceOne({ _id: PHONE }, { _id: PHONE, ...stored }, { upsert: true });
      await expect(settings.getReturnReminderSettings({ phone: PHONE }, deps)).rejects.toMatchObject({ status: 500, code: "RETURN_REMINDER_SETTINGS_INVALID" });
    }
  });

  it("rejects invalid identities and revisions before storage access", async () => {
    expect(settings.setReturnReminderSettings).toBeTypeOf("function");
    const noStorage = { getCollection: () => { throw new Error("Unexpected storage access"); } };
    for (const phone of [undefined, "", {}, "bad-phone"]) await expect(settings.getReturnReminderSettings({ phone }, noStorage)).rejects.toMatchObject({ status: 400, code: "INVALID_PHONE" });
    for (const scheduleRevision of [undefined, -1, 1.5, "0", Number.MAX_SAFE_INTEGER]) await expect(settings.setReturnReminderSettings({ phone: PHONE, schedule: CUSTOM, scheduleRevision }, noStorage)).rejects.toMatchObject({ status: 400 });
  });

  it("reads an explicitly zero revision with no schedule as default and retains the largest readable revision", async () => {
    await records.insertOne({ _id: PHONE, scheduleRevision: 0, adminComments: [] });
    expect(await settings.getReturnReminderSettings({ phone: PHONE }, deps)).toEqual({ schedule: { mode: "default" }, scheduleRevision: 0 });
    await records.updateOne({ _id: PHONE }, { $set: { schedule: CUSTOM, scheduleRevision: Number.MAX_SAFE_INTEGER - 1 } });
    expect(await settings.setReturnReminderSettings({ phone: PHONE, schedule: { mode: "default" }, scheduleRevision: Number.MAX_SAFE_INTEGER - 1 }, deps))
      .toEqual({ schedule: { mode: "default" }, scheduleRevision: Number.MAX_SAFE_INTEGER });
    expect(await settings.getReturnReminderSettings({ phone: PHONE }, deps)).toEqual({ schedule: { mode: "default" }, scheduleRevision: Number.MAX_SAFE_INTEGER });
  });
});
