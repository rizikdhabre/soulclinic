import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { MongoClient, ObjectId } from "mongodb";
import { MongoMemoryReplSet, MongoMemoryServer } from "mongodb-memory-server-core";
import { buildAtomicAvailabilityFilter } from "@/lib/appointmentConcurrency";
import { isTimeSlotAvailable } from "@/lib/appointmentRules";

vi.mock("@/lib/db", () => { throw new Error("Production database import forbidden in monthly schedule tests."); });
const service = await import("@/lib/monthlySchedule").catch(() => ({}));
const TIMEOUT = 120_000;
const NOW = new Date("2026-10-23T07:00:00Z");
let server, client, db, deps;
const input = (overrides = {}) => ({ month: "2026-11", groups: [{ weekdays: [1], mode: "times", times: ["10:00", "12:00"], blockedTimes: ["12:00"] }], excludedDates: [], customizedDays: "replace", ...overrides });

beforeAll(async () => {
  server = await MongoMemoryReplSet.create({ instanceOpts: [{ launchTimeout: TIMEOUT }], replSet: { count: 1, ip: "127.0.0.1", storageEngine: "wiredTiger", spawn: { windowsHide: true } } });
  const uri = server.getUri();
  if (!uri.startsWith("mongodb://127.0.0.1:")) throw new Error("Test Mongo must be loopback only.");
  client = await new MongoClient(uri, { serverSelectionTimeoutMS: 15_000 }).connect();
}, TIMEOUT);
afterAll(async () => { try { await client?.close(); } finally { await server?.stop(); } }, TIMEOUT);
beforeEach(() => {
  expect(service.previewMonthlySchedule).toBeTypeOf("function");
  expect(service.applyMonthlySchedule).toBeTypeOf("function");
  db = client.db(`monthly_schedule_${randomUUID().replaceAll("-", "")}`);
  deps = { db, client, now: () => NOW };
});

const preview = (request = input(), options = deps) => service.previewMonthlySchedule(request, options);
const apply = (request, options = deps) => service.applyMonthlySchedule(request, options);
const state = (month = "2026-11", options = deps) => {
  expect(service.getMonthlyScheduleState).toBeTypeOf("function");
  return service.getMonthlyScheduleState({ month }, options);
};
async function attempt(request = input(), options = deps) {
  return { ...request, previewToken: (await preview(request, options)).previewToken, requestId: randomUUID() };
}

// Intercept only the database boundary; real Mongo sessions and writes still run.
function interceptDayWrites(callback) {
  return { collection(name) {
    const collection = db.collection(name);
    if (name !== "appointments") return collection;
    return new Proxy(collection, { get(target, property) {
      if (property === "updateOne") return async (...args) => { await callback(...args); return target.updateOne(...args); };
      const value = target[property];
      return typeof value === "function" ? value.bind(target) : value;
    } });
  } };
}

describe("atomic monthly schedules", () => {
  it("previews without creating documents, indexes or receipts", async () => {
    const before = await db.listCollections().toArray();
    const result = await preview();
    expect(result.summary).toEqual({ apply: 5, skipped: 0, existingAppointments: 0, affectedAppointments: 0 });
    expect(await db.listCollections().toArray()).toEqual(before);
  });

  it("updates exactly selected dates and preserves appointments, metadata and customer history", async () => {
    const appointment = { _id: new ObjectId(), time: "10:00", duration: 60, firstName: "private", phone: "secret" };
    const existing = { date: "2026-11-02", editedTimes: ["11:00"], blockedTimes: ["11:30"], appointments: [appointment], note: "keep", nested: { revision: 4 } };
    await db.collection("appointments").insertMany([existing, { date: "2026-11-03", marker: "other weekday" }, { date: "2026-12-07", marker: "other month" }]);
    await db.collection("usersData").insertOne({ appointments: [appointment] });
    const request = await attempt(input({ excludedDates: ["2026-11-09"] }));
    const result = await apply(request);
    expect(result).toEqual({ success: true, requestId: request.requestId, summary: { apply: 4, skipped: 1, existingAppointments: 1, affectedAppointments: 0 }, appliedDates: ["2026-11-02", "2026-11-16", "2026-11-23", "2026-11-30"] });
    expect(await db.collection("appointments").findOne({ date: "2026-11-02" })).toMatchObject({ ...existing, editedTimes: ["10:00", "12:00"], blockedTimes: ["12:00"] });
    expect(await db.collection("appointments").findOne({ date: "2026-11-09" })).toBeNull();
    expect(await db.collection("appointments").findOne({ date: "2026-11-03" })).toMatchObject({ marker: "other weekday" });
    expect(await db.collection("appointments").findOne({ date: "2026-12-07" })).toMatchObject({ marker: "other month" });
    expect((await db.collection("usersData").findOne({})).appointments).toEqual([appointment]);
    const receipt = await db.collection("monthlyScheduleApplications").findOne({ _id: request.requestId });
    expect(receipt.result).toEqual(result);
    expect(JSON.stringify(receipt)).not.toMatch(/private|secret/);
  });

  it("replaces existing blocks even with the obsolete preserve option and skips malformed legacy days", async () => {
    await db.collection("appointments").insertMany([{ date: "2026-11-02", blockedTimes: ["10:00"] }, { date: "2026-11-09", editedTimes: "broken" }]);
    const result = await apply(await attempt(input({ customizedDays: "preserve" })));
    expect(result.appliedDates).toEqual(["2026-11-02", "2026-11-16", "2026-11-23", "2026-11-30"]);
    expect(await db.collection("appointments").findOne({ date: "2026-11-02" })).toMatchObject({ editedTimes: ["10:00", "12:00"], blockedTimes: ["12:00"] });
    expect((await db.collection("appointments").findOne({ date: "2026-11-09" })).editedTimes).toBe("broken");
  });

  it("closes an unbooked day while retaining effective starts and existing blocks", async () => {
    await db.collection("appointments").insertOne({ date: "2026-11-02", appointments: [], blockedTimes: ["10:15"] });
    await apply(await attempt(input({ groups: [{ weekdays: [1], mode: "closed" }] })));
    const day = await db.collection("appointments").findOne({ date: "2026-11-02" });
    expect(day.editedTimes).toHaveLength(20);
    expect(day.blockedTimes).toContain("10:15");
    expect(day.blockedTimes).toContain("11:00");
    expect(isTimeSlotAvailable({ day, time: "11:00", duration: 30 })).toBe(false);
  });

  it.each([
    ["editing away a booked start", { weekdays: [1], mode: "times", times: ["10:15", "12:00"], blockedTimes: [] }, "10:00"],
    ["blocking a booked start", { weekdays: [1], mode: "times", times: ["10:00", "12:00"], blockedTimes: ["10:00"] }, "10:00"],
    ["closing a booked day", { weekdays: [1], mode: "closed" }, "10:00"],
    ["closing a day booked outside its offered starts", { weekdays: [1], mode: "closed" }, "21:00"],
  ])("rejects the entire operation when %s, including a later selected date", async (_name, group, time) => {
    await db.collection("appointments").insertMany([
      { date: "2026-11-02", editedTimes: ["11:00"], blockedTimes: [] },
      { date: "2026-11-09", appointments: [{ time, firstName: "private", phone: "secret" }] },
    ]);
    const before = await db.collection("appointments").find().sort({ date: 1 }).toArray();
    const request = await attempt(input({ groups: [group] }));
    const shown = await preview(request);
    expect(shown).toMatchObject({ canApply: false, conflicts: [{ date: "2026-11-09", time }] });
    expect(shown.summary.affectedAppointments).toBe(1);
    await expect(apply(request)).rejects.toMatchObject({ status: 409, code: "APPOINTMENT_CONFLICT", conflicts: [{ date: "2026-11-09", time }] });
    expect(await db.collection("appointments").find().sort({ date: 1 }).toArray()).toEqual(before);
    expect(await db.collection("monthlyScheduleApplications").countDocuments()).toBe(0);
    expect(JSON.stringify(shown)).not.toMatch(/private|secret|firstName|phone/);
  });

  it("reports a newly conflicting booking before a stale preview and writes nothing", async () => {
    const request = await attempt();
    await db.collection("appointments").insertOne({ date: "2026-11-09", appointments: [{ time: "12:00" }] });
    await expect(apply(request)).rejects.toMatchObject({ status: 409, code: "APPOINTMENT_CONFLICT", conflicts: [{ date: "2026-11-09", time: "12:00" }] });
    expect(await db.collection("appointments").countDocuments()).toBe(1);
    expect(await db.collection("monthlyScheduleApplications").countDocuments()).toBe(0);
  });

  it("rejects stale appointments or schedules without changing any selected date", async () => {
    const request = await attempt();
    await db.collection("appointments").insertOne({ date: "2026-11-09", appointments: [{ time: "10:00", duration: 30 }] });
    await expect(apply(request)).rejects.toMatchObject({ status: 409, code: "SCHEDULE_CHANGED" });
    expect(await db.collection("appointments").countDocuments()).toBe(1);
    expect(await db.collection("monthlyScheduleApplications").countDocuments()).toBe(0);
    const request2 = await attempt();
    await db.collection("appointments").updateOne({ date: "2026-11-09" }, { $set: { blockedTimes: ["10:00"] } });
    await expect(apply(request2)).rejects.toMatchObject({ status: 409, code: "SCHEDULE_CHANGED" });
  });

  it("rolls back all prior dates if a later day write fails", async () => {
    const request = await attempt();
    const failingDb = interceptDayWrites(async (filter) => { if (filter.date === "2026-11-09") throw new Error("simulated storage failure"); });
    await expect(apply(request, { ...deps, db: failingDb })).rejects.toMatchObject({ code: "SCHEDULE_STORAGE_UNAVAILABLE", status: 503 });
    expect(await db.collection("appointments").countDocuments()).toBe(0);
    expect(await db.collection("monthlyScheduleApplications").countDocuments()).toBe(0);
  });

  it("rolls back an earlier write when a booking wins on a later existing date after the transaction read", async () => {
    await db.collection("appointments").insertOne({ date: "2026-11-09", appointments: [], editedTimes: [], blockedTimes: [] });
    const request = await attempt();
    const booking = { _id: new ObjectId(), time: "11:00", duration: 30 };
    let booked = false;
    const racingDb = interceptDayWrites(async (filter) => {
      if (filter.date !== "2026-11-09" || booked) return;
      booked = true;
      const reserved = await db.collection("appointments").updateOne(buildAtomicAvailabilityFilter({ date: "2026-11-09", time: "11:00", duration: 30 }), { $push: { appointments: booking } });
      expect(reserved.modifiedCount).toBe(1);
    });
    await expect(apply(request, { ...deps, db: racingDb })).rejects.toMatchObject({ code: "APPOINTMENT_CONFLICT", status: 409, conflicts: [{ date: "2026-11-09", time: "11:00" }] });
    expect((await db.collection("appointments").findOne({ date: "2026-11-09" })).appointments).toEqual([booking]);
    expect(await db.collection("appointments").findOne({ date: "2026-11-02" })).toBeNull();
    expect(await db.collection("monthlyScheduleApplications").countDocuments()).toBe(0);
  });

  it("rejects a concurrent creation of a formerly absent date without duplicate days or partial writes", async () => {
    const request = await attempt();
    let created = false;
    const racingDb = interceptDayWrites(async (filter) => {
      if (filter.date !== "2026-11-09" || created) return;
      created = true;
      await db.collection("appointments").insertOne({ date: "2026-11-09", appointments: [{ time: "11:00", duration: 30 }] });
    });
    await expect(apply(request, { ...deps, db: racingDb })).rejects.toMatchObject({ code: "APPOINTMENT_CONFLICT", status: 409, conflicts: [{ date: "2026-11-09", time: "11:00" }] });
    expect(await db.collection("appointments").countDocuments()).toBe(1);
    expect(await db.collection("monthlyScheduleApplications").countDocuments()).toBe(0);
  });

  it("returns the original receipt on retry even after later edits and clinic midnight", async () => {
    const request = await attempt();
    const result = await apply(request);
    await db.collection("appointments").updateOne({ date: "2026-11-02" }, { $set: { editedTimes: ["15:00"], blockedTimes: [], appointments: [{ time: "15:00" }] } });
    expect(await apply(request, { ...deps, now: () => new Date("2026-11-03T10:00:00Z") })).toEqual(result);
    expect((await db.collection("appointments").findOne({ date: "2026-11-02" })).editedTimes).toEqual(["15:00"]);
    expect(await db.collection("monthlyScheduleApplications").countDocuments()).toBe(1);
  });

  it("recovers a committed receipt when the transaction response is uncertain", async () => {
    const request = await attempt();
    const uncertainClient = { startSession() {
      const session = client.startSession();
      const originalTransaction = session.withTransaction.bind(session);
      session.withTransaction = async (...args) => {
        // Commit through the real session, then lose only its return response.
        await originalTransaction(...args);
        throw Object.assign(new Error("lost commit response"), { hasErrorLabel: (label) => label === "UnknownTransactionCommitResult" });
      };
      return session;
    } };
    const result = await apply(request, { ...deps, client: uncertainClient });
    expect(result.success).toBe(true);
    expect(result.appliedDates).toHaveLength(5);
    expect((await db.collection("monthlyScheduleApplications").findOne({ _id: request.requestId })).result).toEqual(result);
  });

  it("rolls back all day writes when the separate receipt cannot be stored", async () => {
    const request = await attempt();
    const failingDb = { collection(name) {
      const collection = db.collection(name);
      if (name !== "monthlyScheduleApplications") return collection;
      return new Proxy(collection, { get(target, property) {
        if (property === "insertOne") return async () => { throw new Error("receipt storage failed"); };
        const value = target[property];
        return typeof value === "function" ? value.bind(target) : value;
      } });
    } };
    await expect(apply(request, { ...deps, db: failingDb })).rejects.toMatchObject({ code: "SCHEDULE_STORAGE_UNAVAILABLE", status: 503 });
    expect(await db.collection("appointments").countDocuments()).toBe(0);
    expect(await db.collection("monthlyScheduleApplications").countDocuments()).toBe(0);
  });

  it("collapses simultaneous copies of one attempt into one receipt and result", async () => {
    const request = await attempt();
    const results = await Promise.all(Array.from({ length: 4 }, () => apply(request)));
    expect(results.every((result) => JSON.stringify(result) === JSON.stringify(results[0]))).toBe(true);
    expect(await db.collection("monthlyScheduleApplications").countDocuments()).toBe(1);
    expect(await db.collection("appointments").countDocuments()).toBe(5);
  });

  it("allows only one competing different request for the same preview", async () => {
    const request = await attempt();
    const results = await Promise.allSettled([apply(request), apply({ ...request, requestId: randomUUID() })]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.find((result) => result.status === "rejected").reason).toMatchObject({ code: "SCHEDULE_CHANGED", status: 409 });
    expect(await db.collection("monthlyScheduleApplications").countDocuments()).toBe(1);
  });

  it("rejects request UUID reuse for a different intent or preview token", async () => {
    const request = await attempt();
    await apply(request);
    await expect(apply({ ...request, excludedDates: ["2026-11-02"] })).rejects.toMatchObject({ code: "REQUEST_ID_REUSED", status: 409 });
    await expect(apply({ ...request, previewToken: "a".repeat(64) })).rejects.toMatchObject({ code: "REQUEST_ID_REUSED", status: 409 });
  });

  it("replays the same attempt despite a changed obsolete preservation option", async () => {
    const request = await attempt(input({ customizedDays: "preserve" }));
    const result = await apply(request);
    expect(await apply({ ...request, customizedDays: "replace" })).toEqual(result);
    expect(await db.collection("monthlyScheduleApplications").countDocuments()).toBe(1);
  });

  it("rejects an empty eligible set, malformed IDs and tokens without writes", async () => {
    await expect(apply(await attempt(input({ month: "2026-09" })))).rejects.toMatchObject({ code: "NO_DATES_TO_APPLY", status: 400 });
    const request = await attempt();
    for (const change of [{ requestId: "bad" }, { previewToken: "bad" }, { previewToken: null }]) {
      await expect(apply({ ...request, ...change })).rejects.toMatchObject({ code: "INVALID_SCHEDULE", status: 400 });
    }
    expect(await db.collection("appointments").countDocuments()).toBe(0);
    expect(await db.collection("monthlyScheduleApplications").countDocuments()).toBe(0);
  });

  it("fails safely when the unique date index cannot be installed", async () => {
    await db.collection("appointments").insertMany([{ date: "2026-11-02" }, { date: "2026-11-02" }]);
    const request = await attempt();
    await expect(apply(request)).rejects.toMatchObject({ code: "SCHEDULE_STORAGE_UNAVAILABLE", status: 503 });
    expect(await db.collection("appointments").countDocuments()).toBe(2);
    expect(await db.collection("monthlyScheduleApplications").countDocuments()).toBe(0);
  });

  it("accepts an existing full unique date index under a different name", async () => {
    await db.collection("appointments").createIndex({ date: 1 }, { unique: true, name: "legacy_unique_date" });
    const result = await apply(await attempt());
    expect(result.appliedDates).toHaveLength(5);
    expect(await db.collection("monthlyScheduleApplications").countDocuments()).toBe(1);
  });

  it.each([
    { unique: false }, { unique: true, sparse: true }, { unique: true, partialFilterExpression: { protected: true } },
  ])("rejects an incompatible date index that prevents installing the required full unique index: %j", async (indexOptions) => {
    await db.collection("appointments").createIndex({ date: 1 }, { ...indexOptions, name: "unique_appointment_date" });
    await expect(apply(await attempt())).rejects.toMatchObject({ code: "SCHEDULE_STORAGE_UNAVAILABLE", status: 503 });
    expect(await db.collection("appointments").countDocuments()).toBe(0);
    expect(await db.collection("monthlyScheduleApplications").countDocuments()).toBe(0);
  });

  it("does not fall back to partial writes on a standalone Mongo server", async () => {
    const standalone = await MongoMemoryServer.create({ instance: { ip: "127.0.0.1", launchTimeout: TIMEOUT }, spawn: { windowsHide: true } });
    const standaloneClient = await new MongoClient(standalone.getUri(), { serverSelectionTimeoutMS: 15_000 }).connect();
    const standaloneDb = standaloneClient.db("monthly_schedule_standalone");
    const options = { db: standaloneDb, client: standaloneClient, now: () => NOW };
    try {
      await expect(apply(await attempt(input(), options), options)).rejects.toMatchObject({ code: "TRANSACTIONS_REQUIRED", status: 503 });
      expect(await standaloneDb.collection("appointments").countDocuments()).toBe(0);
      expect(await standaloneDb.collection("monthlyScheduleApplications").countDocuments()).toBe(0);
    } finally { await standaloneClient.close(); await standalone.stop(); }
  }, TIMEOUT);
});

describe("persisted monthly state", () => {
  it("returns every date with effective defaults without creating collections or indexes", async () => {
    const before = await db.listCollections().toArray();
    const result = await state();
    expect(result.month).toBe("2026-11");
    expect(result.days).toHaveLength(30);
    expect(result.days[0]).toMatchObject({ date: "2026-11-01", weekday: 0, valid: true, customized: false, blockedTimes: [], appointmentTimes: [] });
    expect(result.days[0].times).toEqual(["10:00", "10:30", "11:00", "11:30", "12:00", "12:30", "13:00", "13:30", "14:00", "14:30", "15:00", "15:30", "16:00", "16:30", "17:00", "17:30", "18:00", "18:30", "19:00", "19:30"]);
    expect(result.days.at(-1).date).toBe("2026-11-30");
    expect((await state("2028-02")).days).toHaveLength(29);
    expect(await db.listCollections().toArray()).toEqual(before);
  });

  it("reads saved edited and blocked starts with unique appointment times only, including daily-route changes", async () => {
    await db.collection("appointments").insertMany([
      { date: "2026-11-02", editedTimes: ["12:30", "10:15"], blockedTimes: ["12:30", "21:00"], appointments: [{ _id: new ObjectId(), time: "10:15", firstName: "private", phone: "secret", duration: 60 }, { time: "10:15" }] },
      { date: "2026-11-03", editedTimes: [], blockedTimes: [] },
      { date: "2026-12-02", editedTimes: ["11:00"] },
    ]);
    const first = await state();
    expect(first.days[1]).toEqual({ date: "2026-11-02", weekday: 1, times: ["10:15", "12:30"], blockedTimes: ["12:30", "21:00"], appointmentTimes: ["10:15"], valid: true, customized: true });
    expect(first.days[2]).toMatchObject({ valid: true, customized: false });
    expect(first.days[2].times).toHaveLength(20);
    expect(JSON.stringify(first)).not.toMatch(/private|secret|firstName|phone|duration|_id/);
    await db.collection("appointments").updateOne({ date: "2026-11-02" }, { $set: { editedTimes: ["10:45", "12:30"], blockedTimes: ["10:45"] } });
    expect((await state()).days[1]).toMatchObject({ times: ["10:45", "12:30"], blockedTimes: ["10:45"] });
  });

  it("loads monthly apply results again from appointment documents", async () => {
    await apply(await attempt());
    const saved = await state();
    expect(saved.days[1]).toMatchObject({ times: ["10:00", "12:00"], blockedTimes: ["12:00"], customized: true, valid: true });
    expect(saved.days[2]).toMatchObject({ customized: false, blockedTimes: [] });
    await state("2026-12");
    expect(await state()).toEqual(saved);
  });

  it("marks malformed and duplicate dates invalid while returning safe time arrays", async () => {
    await db.collection("appointments").insertMany([
      { date: "2026-11-02", editedTimes: "broken", blockedTimes: "broken", appointments: [null, { time: "bad", phone: "secret" }, { time: "11:00" }] },
      { date: "2026-11-03", editedTimes: ["10:15"] },
      { date: "2026-11-03", editedTimes: ["10:30"] },
    ]);
    const saved = await state();
    expect(saved.days[1]).toMatchObject({ valid: false, times: [], blockedTimes: [], appointmentTimes: ["11:00"] });
    expect(saved.days[2].valid).toBe(false);
    expect(JSON.stringify(saved)).not.toMatch(/broken|secret|phone/);
  });

  it.each([undefined, null, "2026-1", "2026-13", "2026-11-02", { month: "2026-11" }])("rejects invalid month %j before database access", async (month) => {
    expect(service.getMonthlyScheduleState).toBeTypeOf("function");
    const neverDb = { collection() { throw new Error("Database must not be accessed for an invalid month"); } };
    await expect(service.getMonthlyScheduleState({ month }, { db: neverDb })).rejects.toMatchObject({ code: "INVALID_SCHEDULE", status: 400 });
  });

  it("returns a safe error when saved month storage is unavailable", async () => {
    expect(service.getMonthlyScheduleState).toBeTypeOf("function");
    const brokenDb = { collection() { throw new Error("secret database URI"); } };
    await expect(service.getMonthlyScheduleState({ month: "2026-11" }, { db: brokenDb })).rejects.toMatchObject({ code: "SCHEDULE_STORAGE_UNAVAILABLE", status: 503 });
  });
});
