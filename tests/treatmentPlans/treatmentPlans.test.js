import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { MongoClient, ObjectId } from "mongodb";
import { MongoMemoryReplSet, MongoMemoryServer } from "mongodb-memory-server-core";
import { createTreatmentPlan } from "@/lib/treatmentPlans";

vi.mock("@/lib/db", () => {
  throw new Error("Application database import is forbidden in treatment-plan tests.");
});
vi.mock("@/lib/whatsapp", () => {
  throw new Error("Real WhatsApp import is forbidden in treatment-plan tests.");
});

const TIMEOUT = 120_000;
const NOW = new Date("2026-10-23T07:00:00.000Z"); // 10:00 in Israel.
let server;
let client;
let db;
let deps;
let userId;
let treatmentId;
let deliveries;
const service = { title: "حجامة", duration: 60, price: 120, cupsCount: 8 };

beforeAll(async () => {
  server = await MongoMemoryReplSet.create({
    instanceOpts: [{ launchTimeout: TIMEOUT }],
    replSet: { count: 1, ip: "127.0.0.1", storageEngine: "wiredTiger", spawn: { windowsHide: true } },
  });
  const uri = server.getUri();
  if (!uri.startsWith("mongodb://127.0.0.1:")) throw new Error("Test Mongo must be loopback only.");
  client = await new MongoClient(uri, { serverSelectionTimeoutMS: 15_000, monitorCommands: true }).connect();
}, TIMEOUT);

afterAll(async () => {
  try { await client?.close(); } finally { await server?.stop(); }
}, TIMEOUT);

beforeEach(async () => {
  db = client.db(`plans_${randomUUID().replaceAll("-", "")}`);
  userId = new ObjectId();
  treatmentId = new ObjectId();
  deliveries = [];
  await db.collection("usersData").insertOne({ _id: userId, firstName: "أحمد", lastName: "سالم", phone: "+972521234567", appointments: [], notes: [] });
  await db.collection("treatments").insertOne({ _id: treatmentId, services: [service] });
  deps = {
    db, client, now: () => NOW,
    env: { TWILIO_TEMPLATE_SOUL_TREATMENT_PLAN: "HXlocal-treatment-plan" },
    sendTemplate: async (message) => {
      // Actual provider boundary sees only data committed and visible to a separate read.
      expect(await db.collection("treatmentPlans").countDocuments()).toBe(1);
      expect((await db.collection("usersData").findOne({ _id: userId })).appointments.length).toBeGreaterThan(0);
      deliveries.push(message);
      return { sid: "SMlocal-plan-confirmation" };
    },
  };
});

function row(overrides = {}) {
  return { treatmentId: String(treatmentId), serviceIndex: 0, expectedService: { ...service }, date: "2026-10-24", time: "10:00", ...overrides };
}

function input(appointments = [row()], overrides = {}) {
  return { userId: String(userId), requestId: randomUUID(), appointments, ...overrides };
}

async function expectNoBookings() {
  expect(await db.collection("treatmentPlans").countDocuments()).toBe(0);
  expect((await db.collection("usersData").findOne({ _id: userId })).appointments).toEqual([]);
  const days = await db.collection("appointments").find({}).toArray();
  expect(days.flatMap((day) => day.appointments || [])).toEqual([]);
  expect(deliveries).toEqual([]);
}

describe("atomic treatment plans", () => {
  it("stores the existing two-copy shape with shared appointment IDs and sends one complete schedule after commit", async () => {
    const result = await createTreatmentPlan(input([row(), row({ date: "2026-10-31", time: "11:00" })]), deps);
    expect(result).toMatchObject({ success: true, notification: { status: "sent" } });
    expect(result.appointmentIds).toHaveLength(2);
    const plan = await db.collection("treatmentPlans").findOne({ _id: new ObjectId(result.planId) });
    const user = await db.collection("usersData").findOne({ _id: userId });
    const days = await db.collection("appointments").find({}).sort({ date: 1 }).toArray();
    expect(plan.userId).toEqual(userId);
    expect(plan.appointments).toHaveLength(2);
    expect(plan.notification.status).toBe("sent");
    expect(days).toHaveLength(2);
    for (const [index, entry] of user.appointments.entries()) {
      expect(String(entry._id)).toBe(result.appointmentIds[index]);
      expect(entry).toMatchObject({ title: "حجامة", price: 120, attended: false, cupsCount: 8, treatmentPlanId: plan._id });
      expect(days[index].appointments[0]).toMatchObject({ _id: entry._id, firstName: "أحمد", lastName: "سالم", phone: "+972521234567", duration: 60, reminderSent: false, cupsCount: 8, treatmentPlanId: plan._id });
      expect(days[index].appointments[0]).not.toHaveProperty("price");
      expect(entry).not.toHaveProperty("duration");
    }
    expect(deliveries).toEqual([{
      to: "whatsapp:+972521234567", templateSid: "HXlocal-treatment-plan",
      variables: { 1: "أحمد سالم", 2: "2026-10-24 10:00 - حجامة | 2026-10-31 11:00 - حجامة" },
    }]);
  });

  it("rolls back earlier day writes when a later row conflicts", async () => {
    const occupied = { _id: new ObjectId(), time: "11:00", duration: 60 };
    await db.collection("appointments").insertOne({ date: "2026-10-31", appointments: [occupied], blockedTimes: [], editedTimes: [] });
    await expect(createTreatmentPlan(input([row(), row({ date: "2026-10-31", time: "11:30" })]), deps)).rejects.toMatchObject({ code: "TIME_SLOT_UNAVAILABLE", status: 409, rowIndex: 1 });
    expect(await db.collection("appointments").findOne({ date: "2026-10-24" })).toBeNull();
    expect((await db.collection("appointments").findOne({ date: "2026-10-31" })).appointments).toEqual([occupied]);
    expect((await db.collection("usersData").findOne({ _id: userId })).appointments).toEqual([]);
    expect(await db.collection("treatmentPlans").countDocuments()).toBe(0);
    expect(deliveries).toEqual([]);
  });

  it("rolls back reservations if customer history cannot be written", async () => {
    await db.collection("usersData").updateOne({ _id: userId }, { $set: { appointments: "malformed legacy value" } });
    await expect(createTreatmentPlan(input(), deps)).rejects.toMatchObject({ code: "TREATMENT_PLAN_FAILED", status: 500 });
    expect(await db.collection("appointments").countDocuments()).toBe(0);
    expect(await db.collection("treatmentPlans").countDocuments()).toBe(0);
    expect(deliveries).toEqual([]);
  });

  it("rejects same-day overlaps within the batch before creating any reservations", async () => {
    await expect(createTreatmentPlan(input([row(), row({ time: "10:30" })]), deps)).rejects.toMatchObject({ code: "PLAN_ROWS_OVERLAP", status: 409, rowIndex: 1 });
    await expectNoBookings();
  });

  it("permits adjacent same-day appointments", async () => {
    const result = await createTreatmentPlan(input([row(), row({ time: "11:00" })]), deps);
    expect(result.appointmentIds).toHaveLength(2);
    expect((await db.collection("appointments").findOne({ date: "2026-10-24" })).appointments).toHaveLength(2);
  });

  it("resolves price and duration from the catalog and rejects a stale service index snapshot", async () => {
    await db.collection("treatments").updateOne({ _id: treatmentId }, { $set: { services: [{ ...service, price: 999 }] } });
    await expect(createTreatmentPlan(input(), deps)).rejects.toMatchObject({ code: "SERVICE_CHANGED", status: 409, rowIndex: 0 });
    await expectNoBookings();
  });

  it("accepts numeric catalog strings and absent optional cups without trusting payload extras", async () => {
    await db.collection("treatments").updateOne({ _id: treatmentId }, { $set: { services: [{ title: "تدليك", duration: "30", price: "85" }] } });
    const result = await createTreatmentPlan(input([row({ expectedService: { title: "تدليك", duration: 30, price: 85, cupsCount: null }, price: 1, duration: 1 })]), deps);
    const user = await db.collection("usersData").findOne({ _id: userId });
    expect(user.appointments[0]).toMatchObject({ _id: new ObjectId(result.appointmentIds[0]), title: "تدليك", price: 85 });
    expect(user.appointments[0]).not.toHaveProperty("cupsCount");
    expect((await db.collection("appointments").findOne({ date: "2026-10-24" })).appointments[0].duration).toBe(30);
  });

  it.each([
    ["malformed date", { date: "2026-02-30" }],
    ["nonpadded time", { time: "9:00" }],
    ["elapsed Israel time", { date: "2026-10-23", time: "09:30" }],
    ["current Israel minute", { date: "2026-10-23", time: "10:00" }],
    ["past date", { date: "2026-10-22" }],
  ])("rejects %s", async (_label, override) => {
    await expect(createTreatmentPlan(input([row(override)]), deps)).rejects.toMatchObject({ code: "INVALID_APPOINTMENT", status: 400, rowIndex: 0 });
    await expectNoBookings();
  });

  it.each([
    ["blocked start", { blockedTimes: ["10:00"] }, "10:00"],
    ["custom schedule", { editedTimes: ["12:15"] }, "10:00"],
    ["ends after working hours", {}, "19:00"],
  ])("respects existing %s rules", async (_label, day, time) => {
    await db.collection("appointments").insertOne({ date: "2026-10-24", appointments: [], blockedTimes: [], editedTimes: [], ...day });
    await expect(createTreatmentPlan(input([row({ time })]), deps)).rejects.toMatchObject({ code: "TIME_SLOT_UNAVAILABLE", status: 409 });
    await expectNoBookings();
  });

  it("replays one request after its dates become past and catalog changes without rebooking or sending", async () => {
    const request = input();
    const first = await createTreatmentPlan(request, deps);
    await db.collection("treatments").deleteMany({});
    const replay = await createTreatmentPlan(request, { ...deps, now: () => new Date("2027-01-01T00:00:00Z") });
    expect(replay).toEqual(first);
    expect((await db.collection("usersData").findOne({ _id: userId })).appointments).toHaveLength(1);
    expect(deliveries).toHaveLength(1);
  });

  it("rejects a request ID reused with a changed payload", async () => {
    const request = input();
    await createTreatmentPlan(request, deps);
    await expect(createTreatmentPlan({ ...request, appointments: [row({ time: "12:00" })] }, deps)).rejects.toMatchObject({ code: "REQUEST_ID_REUSED", status: 409 });
    expect((await db.collection("usersData").findOne({ _id: userId })).appointments).toHaveLength(1);
    expect(deliveries).toHaveLength(1);
  });

  it("concurrent identical submissions commit one batch and claim one notification", async () => {
    const request = input([row(), row({ date: "2026-10-31" })]);
    const results = await Promise.all(Array.from({ length: 6 }, () => createTreatmentPlan(request, deps)));
    expect(new Set(results.map((result) => result.planId)).size).toBe(1);
    expect(await db.collection("treatmentPlans").countDocuments()).toBe(1);
    expect((await db.collection("usersData").findOne({ _id: userId })).appointments).toHaveLength(2);
    expect(deliveries).toHaveLength(1);
  }, TIMEOUT);

  it("concurrent different plans cannot double-book the same new day", async () => {
    const results = await Promise.allSettled([createTreatmentPlan(input(), deps), createTreatmentPlan(input(), deps)]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.find((result) => result.status === "rejected").reason).toMatchObject({ code: "TIME_SLOT_UNAVAILABLE", status: 409 });
    expect(await db.collection("treatmentPlans").countDocuments()).toBe(1);
    expect((await db.collection("appointments").findOne({ date: "2026-10-24" })).appointments).toHaveLength(1);
    expect(deliveries).toHaveLength(1);
  }, TIMEOUT);

  it("books successfully with an unconfigured template and never sends on a replay", async () => {
    const request = input();
    const result = await createTreatmentPlan(request, { ...deps, env: {} });
    expect(result.notification.status).toBe("not_configured");
    expect((await db.collection("usersData").findOne({ _id: userId })).appointments).toHaveLength(1);
    expect((await createTreatmentPlan(request, deps)).notification.status).toBe("not_configured");
    expect(deliveries).toEqual([]);
  });

  it("does not dispatch a pending committed plan after its template configuration disappears", async () => {
    const request = input();
    const result = await createTreatmentPlan(request, { ...deps, env: {} });
    // A process can stop just after commit, leaving the original pending state.
    await db.collection("treatmentPlans").updateOne({ _id: new ObjectId(result.planId) }, { $set: { notification: { status: "pending" } } });
    const replay = await createTreatmentPlan(request, { ...deps, env: {} });
    expect(replay.notification.status).toBe("not_configured");
    expect((await db.collection("treatmentPlans").findOne({ _id: new ObjectId(result.planId) })).notification.status).toBe("not_configured");
    expect(deliveries).toEqual([]);
  });

  it("collapses line breaks and repeated whitespace in both approved template variables", async () => {
    await db.collection("usersData").updateOne({ _id: userId }, { $set: { firstName: "أحمد\n  سالم", lastName: "علي\t" } });
    const multilineService = { ...service, title: "حجامة\r\n  علاجية" };
    await db.collection("treatments").updateOne({ _id: treatmentId }, { $set: { services: [multilineService] } });
    await createTreatmentPlan(input([row({ expectedService: multilineService })]), deps);
    expect(deliveries[0].variables).toEqual({ 1: "أحمد سالم علي", 2: "2026-10-24 10:00 - حجامة علاجية" });
  });

  it("does not reclaim a notification while its first provider call is still in flight", async () => {
    const request = input();
    let begin;
    let finish;
    const started = new Promise((resolve) => { begin = resolve; });
    const providerResponse = new Promise((resolve) => { finish = resolve; });
    let attempts = 0;
    const slowDeps = { ...deps, sendTemplate: async () => { attempts++; begin(); await providerResponse; return { sid: "SMslow" }; } };
    const first = createTreatmentPlan(request, slowDeps);
    try {
      await started;
      const replay = await createTreatmentPlan(request, slowDeps);
      expect(replay.notification.status).toBe("unknown");
      expect(attempts).toBe(1);
    } finally { finish(); }
    expect((await first).notification.status).toBe("sent");
    expect(attempts).toBe(1);
  });

  it("recovers a committed plan when the transaction acknowledgement is lost", async () => {
    const request = input();
    const uncertainClient = {
      startSession() {
        const session = client.startSession();
        const transact = session.withTransaction.bind(session);
        session.withTransaction = async (callback, options) => {
          await transact(callback, options);
          throw Object.assign(new Error("commit acknowledgement lost"), { hasErrorLabel: (label) => label === "UnknownTransactionCommitResult" });
        };
        return session;
      },
    };
    const result = await createTreatmentPlan(request, { ...deps, client: uncertainClient });
    expect(result).toMatchObject({ success: true, notification: { status: "sent" } });
    expect((await createTreatmentPlan(request, deps)).planId).toBe(result.planId);
    expect((await db.collection("usersData").findOne({ _id: userId })).appointments).toHaveLength(1);
    expect(deliveries).toHaveLength(1);
  });

  it("requires majority-committed receipts before treating a replay as a successful booking", async () => {
    const request = input();
    await createTreatmentPlan(request, deps);
    const receipts = [];
    const collect = ({ commandName, command }) => {
      if (commandName === "find" && command.find === "treatmentPlans" && !command.autocommit) receipts.push(command);
    };
    client.on("commandStarted", collect);
    try { await createTreatmentPlan(request, deps); }
    finally { client.off("commandStarted", collect); }
    expect(receipts).toHaveLength(1);
    expect(receipts[0].readConcern).toEqual({ level: "majority" });
  });

  it.each([[400, "failed"], [503, "unknown"], [undefined, "unknown"]])("records provider status %s as %s without turning a committed booking into a failure or retrying", async (status, expected) => {
    const request = input();
    let attempts = 0;
    const failureDeps = { ...deps, sendTemplate: async () => { attempts++; throw Object.assign(new Error("provider failure"), { status }); } };
    const result = await createTreatmentPlan(request, failureDeps);
    expect(result).toMatchObject({ success: true, notification: { status: expected } });
    expect((await createTreatmentPlan(request, failureDeps)).notification.status).toBe(expected);
    expect(attempts).toBe(1);
    expect((await db.collection("usersData").findOne({ _id: userId })).appointments).toHaveLength(1);
  });

  it("rejects too many rows and an invalid request ID", async () => {
    await expect(createTreatmentPlan(input(Array.from({ length: 11 }, (_, i) => row({ date: `2026-11-${String(i + 1).padStart(2, "0")}` }))), deps)).rejects.toMatchObject({ code: "INVALID_APPOINTMENTS", status: 400 });
    await expect(createTreatmentPlan(input([row()], { requestId: "not-a-uuid" }), deps)).rejects.toMatchObject({ code: "INVALID_REQUEST_ID", status: 400 });
    await expectNoBookings();
  });

  it("rejects a full schedule exceeding template capacity before any booking", async () => {
    const longService = { ...service, title: "ع".repeat(682) }; // 19 prefix characters + 682 = 701.
    await db.collection("treatments").updateOne({ _id: treatmentId }, { $set: { services: [longService] } });
    await expect(createTreatmentPlan(input([row({ expectedService: longService })]), deps)).rejects.toMatchObject({ code: "SCHEDULE_TOO_LONG", status: 400 });
    await expectNoBookings();
  });

  it("rejects overlong customer names and unsafe catalog durations before booking", async () => {
    await db.collection("usersData").updateOne({ _id: userId }, { $set: { firstName: "ن".repeat(81) } });
    await expect(createTreatmentPlan(input(), deps)).rejects.toMatchObject({ code: "INVALID_CUSTOMER", status: 400 });
    await db.collection("usersData").updateOne({ _id: userId }, { $set: { firstName: "أحمد" } });
    await db.collection("treatments").updateOne({ _id: treatmentId }, { $set: { services: [{ ...service, duration: -30 }] } });
    await expect(createTreatmentPlan(input(), deps)).rejects.toMatchObject({ code: "INVALID_SERVICE", status: 409 });
    await expectNoBookings();
  });

  it("fails closed if legacy duplicate day documents prevent a unique date index", async () => {
    await db.collection("appointments").insertMany([{ date: "2026-10-24", appointments: [] }, { date: "2026-10-24", appointments: [] }]);
    await expect(createTreatmentPlan(input(), deps)).rejects.toMatchObject({ code: "BOOKING_INDEX_UNAVAILABLE", status: 503 });
    await expectNoBookings();
  });
});

it("requires transaction support and writes no reservations on standalone Mongo", async () => {
  const standalone = await MongoMemoryServer.create({ instance: { ip: "127.0.0.1", storageEngine: "wiredTiger", launchTimeout: TIMEOUT }, spawn: { windowsHide: true } });
  let standaloneClient;
  try {
    const uri = standalone.getUri();
    if (!uri.startsWith("mongodb://127.0.0.1:")) throw new Error("Test Mongo must be loopback only.");
    standaloneClient = await new MongoClient(uri).connect();
    const standaloneDb = standaloneClient.db("standalone_plan_test");
    await standaloneDb.collection("usersData").insertOne({ _id: userId, firstName: "Test", lastName: "Customer", phone: "+972521234567", appointments: [] });
    await standaloneDb.collection("treatments").insertOne({ _id: treatmentId, services: [service] });
    await expect(createTreatmentPlan(input(), { ...deps, db: standaloneDb, client: standaloneClient })).rejects.toMatchObject({ code: "TRANSACTIONS_REQUIRED", status: 503 });
    expect(await standaloneDb.collection("appointments").countDocuments()).toBe(0);
    expect(await standaloneDb.collection("treatmentPlans").countDocuments()).toBe(0);
    expect((await standaloneDb.collection("usersData").findOne({ _id: userId })).appointments).toEqual([]);
    expect(deliveries).toEqual([]);
  } finally {
    await standaloneClient?.close();
    await standalone.stop();
  }
}, TIMEOUT);
