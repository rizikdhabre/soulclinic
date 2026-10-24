import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { MongoClient, ObjectId } from "mongodb";
import { MongoMemoryServer } from "mongodb-memory-server-core";

vi.mock("@/lib/db", () => ({ getCollection: () => { throw new Error("Application database access forbidden"); } }));
const { loadTomorrowAppointments, loadUnreportedFeedback } = await import("@/lib/adminDailyReportData").catch(() => ({}));
const DATE = "2026-10-26";
const FROM = new Date("2026-10-24T18:00:00Z");
const THROUGH = new Date("2026-10-25T19:00:00Z");
let server, client, db, deps;

beforeAll(async () => {
  server = await MongoMemoryServer.create({ instance: { ip: "127.0.0.1", launchTimeout: 120_000 }, spawn: { windowsHide: true } });
  const uri = server.getUri();
  if (!uri.startsWith("mongodb://127.0.0.1:")) throw new Error("Loopback database required");
  client = await new MongoClient(uri, { monitorCommands: true }).connect();
  db = client.db("admin_report_data_test");
}, 120_000);
afterAll(async () => { await client?.close(); await server?.stop(); });
beforeEach(async () => {
  await db.dropDatabase();
  deps = { getCollection: async (name) => db.collection(name) };
});

const id = (number) => new ObjectId(number.toString(16).padStart(24, "0"));
const slot = (number, extra = {}) => ({ _id: id(number), firstName: "أحمد", lastName: "علي", phone: "+972521234567", time: "12:00", ...extra });
const record = (number, extra = {}) => ({ _id: id(number), userId: id(1), appointmentId: id(number), feedback: { submittedAt: FROM, text: "تحسّن جيد", painRelief: 8 }, ...extra });

describe("canonical tomorrow appointment data", () => {
  it("includes only the selected calendar date, sorted by time/id, including premarked attendance", async () => {
    const slots = [slot(12), slot(11, { time: "10:00", attended: true }), slot(10, { time: "10:00" })];
    await db.collection("appointments").insertMany([
      { date: DATE, appointments: slots }, { date: "2026-10-27", appointments: [slot(13)] },
    ]);
    await db.collection("usersData").insertOne({ _id: id(1), phone: "052-1234567", appointments: slots.map((a) => ({
      _id: a._id, time: a.time, date: DATE, title: `علاج ${a._id}`, attended: true,
    })) });
    await db.collection("treatmentPlans").insertOne({ userId: id(1), appointments: [{ _id: id(14), date: DATE, time: "09:00", title: "ملغى" }] });
    const rows = await loadTomorrowAppointments({ date: DATE }, deps);
    expect(rows.map((row) => row.id.toString())).toEqual([id(10), id(11), id(12)].map(String));
    expect(rows[0]).toEqual({ id: id(10), name: "أحمد علي", phone: "+972521234567", title: `علاج ${id(10)}`, time: "10:00" });
  });

  it("never substitutes another owner or a mismatched date/time treatment and never drops an unmatched calendar entry", async () => {
    await db.collection("appointments").insertOne({ date: DATE, appointments: [slot(10), slot(11), slot(12), slot(13), slot(14)] });
    await db.collection("usersData").insertMany([
      { _id: id(1), phone: "+972521234567", appointments: [
        { _id: id(10), date: DATE, time: "12:00", title: "العلاج الصحيح" },
        { _id: id(11), date: "2026-10-27", time: "12:00", title: "WRONG_DATE" },
        { _id: id(12), date: DATE, time: "13:00", title: "WRONG_TIME" },
      ] },
      { _id: id(2), phone: "+972541234567", appointments: [{ _id: id(13), date: DATE, time: "12:00", title: "WRONG_OWNER" }] },
    ]);
    const rows = await loadTomorrowAppointments({ date: DATE }, deps);
    expect(rows).toHaveLength(5);
    expect(rows.map((r) => r.title)).toEqual(["العلاج الصحيح", ...Array(4).fill("علاج غير محدد")]);
    expect(JSON.stringify(rows)).not.toMatch(/WRONG_/);
  });

  it("returns an empty list for an empty calendar and rejects malformed dates before reads", async () => {
    expect(await loadTomorrowAppointments({ date: DATE }, deps)).toEqual([]);
    const getCollection = vi.fn();
    await expect(loadTomorrowAppointments({ date: "2026-02-30" }, { getCollection })).rejects.toThrow("INVALID_REPORT_DATE");
    expect(getCollection).not.toHaveBeenCalled();
  });
});

describe("new feedback data", () => {
  it("uses submittedAt >= baseline and < cutoff, ignores requests/strings and claimed feedback, and orders ties by ID", async () => {
    await db.collection("appointmentFeedback").insertMany([
      record(12), record(10), record(11, { feedback: { text: "last", submittedAt: new Date(THROUGH.getTime() - 1) } }),
      record(13, { feedback: { text: "cutoff", submittedAt: THROUGH } }),
      record(14, { feedback: { text: "old", submittedAt: new Date(FROM.getTime() - 1) } }),
      record(15, { feedback: { text: "invalid date", submittedAt: FROM.toISOString() } }),
      record(16, { feedback: undefined, createdAt: FROM }), record(17),
    ]);
    await db.collection("adminDailyReportFeedback").insertOne({ _id: id(17), reportId: "yesterday-feedback" });
    const rows = await loadUnreportedFeedback({ from: FROM, through: THROUGH }, deps);
    expect(rows.map((row) => row.id)).toEqual([id(10), id(12), id(11)]);
    expect(rows.every((row) => row.id instanceof ObjectId)).toBe(true);
    expect(rows[2]).toMatchObject({ name: "زبون غير متوفر", title: "علاج غير محدد", text: "last", painRelief: null });
    // The inclusive/exclusive boundary makes a 21:00 submission visible next day.
    expect((await loadUnreportedFeedback({ from: THROUGH, through: new Date(THROUGH.getTime() + 86400000) }, deps)).map((r) => r.id)).toEqual([id(13)]);
  });

  it("joins name and title using the exact customer and appointment and recovers only owned plan snapshots", async () => {
    await db.collection("usersData").insertMany([
      { _id: id(1), firstName: "أحمد", lastName: "علي", appointments: [{ _id: id(10), title: "علاج مباشر" }], adminNotes: "SECRET" },
      { _id: id(2), firstName: "OTHER", lastName: "OWNER", appointments: [{ _id: id(12), title: "WRONG_OWNER" }] },
    ]);
    await db.collection("treatmentPlans").insertMany([
      { userId: id(1), appointments: [{ _id: id(11), title: "علاج من برنامج محفوظ" }] },
      { userId: id(2), appointments: [{ _id: id(12), title: "WRONG_PLAN" }] },
    ]);
    await db.collection("appointmentFeedback").insertMany([record(10), record(11), record(12), record(13, { userId: id(3) })]);
    const rows = await loadUnreportedFeedback({ from: FROM, through: THROUGH }, deps);
    expect(rows.map((r) => r.title)).toEqual(["علاج مباشر", "علاج من برنامج محفوظ", "علاج غير محدد", "علاج غير محدد"]);
    expect(rows.map((r) => r.name)).toEqual(["أحمد علي", "أحمد علي", "أحمد علي", "زبون غير متوفر"]);
    expect(JSON.stringify(rows)).not.toMatch(/SECRET|WRONG|OTHER/);
  });

  it("does not lose a late database commit inside the established baseline or truncate legacy comments", async () => {
    await db.collection("appointmentFeedback").insertOne(record(10));
    const first = await loadUnreportedFeedback({ from: FROM, through: THROUGH }, deps);
    await db.collection("adminDailyReportFeedback").insertOne({ _id: first[0].id });
    const text = "قديم\n".repeat(1000);
    await db.collection("appointmentFeedback").insertOne(record(11, { feedback: { text, submittedAt: new Date(FROM.getTime() + 1000) } }));
    const rows = await loadUnreportedFeedback({ from: FROM, through: new Date(THROUGH.getTime() + 86400000) }, deps);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: id(11), text, painRelief: null });
  });

  it("recovers a missing live title from an owned snapshot but does not guess between conflicting live titles", async () => {
    await db.collection("usersData").insertOne({ _id: id(1), appointments: [
      { _id: id(10) }, { _id: id(11), title: "حجامة" }, { _id: id(11), title: "إبر صينية" },
    ] });
    await db.collection("treatmentPlans").insertOne({ userId: id(1), appointments: [
      { _id: id(10), title: "علاج محفوظ" }, { _id: id(11), title: "نسخة سابقة" },
    ] });
    await db.collection("appointmentFeedback").insertMany([record(10), record(11)]);
    expect((await loadUnreportedFeedback({ from: FROM, through: THROUGH }, deps)).map((r) => r.title))
      .toEqual(["علاج محفوظ", "علاج غير محدد"]);
  });

  it("limits read projections and uses the supplied session/maxTimeMS without any writes", async () => {
    await db.collection("appointmentFeedback").insertOne(record(10));
    const commands = [];
    const listener = (event) => { if (["find", "insert", "update", "delete"].includes(event.commandName)) commands.push(event); };
    client.on("commandStarted", listener);
    const session = client.startSession();
    try {
      await loadUnreportedFeedback({ from: FROM, through: THROUGH }, { ...deps, session, maxTimeMS: 2500 });
      expect(commands.length).toBeGreaterThan(0);
      expect(commands.every((c) => c.commandName === "find")).toBe(true);
      expect(commands.every((c) => c.command.maxTimeMS === 2500 && c.command.lsid && c.command.projection)).toBe(true);
      expect(commands.find((c) => c.command.find === "appointmentFeedback").command.projection).not.toHaveProperty("tokenHash");
    } finally { client.off("commandStarted", listener); await session.endSession(); }
  });

  it("rejects invalid/non-Date/reversed ranges before touching the database", async () => {
    const getCollection = vi.fn();
    for (const range of [{ from: FROM.toISOString(), through: THROUGH }, { from: new Date(NaN), through: THROUGH }, { from: THROUGH, through: FROM }]) {
      await expect(loadUnreportedFeedback(range, { getCollection })).rejects.toThrow("INVALID_REPORT_RANGE");
    }
    expect(getCollection).not.toHaveBeenCalled();
  });
});
