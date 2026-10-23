import { createHash } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { MongoClient, ObjectId } from "mongodb";
import { MongoMemoryServer } from "mongodb-memory-server-core";
import { getReturnReminderEligibility, sendDueReturnReminders } from "@/lib/returnReminders";
import { optOutReturnRemindersByPhone } from "@/lib/returnReminderPreferences";

vi.mock("@/lib/db", () => ({ getCollection: () => { throw new Error("Application database forbidden"); } }));
vi.mock("@/lib/whatsapp", () => ({ sendWhatsAppTemplate: () => { throw new Error("Real messages forbidden"); } }));

const NOW = new Date("2026-10-23T09:00:00.000Z"); // 12:00 Israel
const PHONE = "+972521234567";
const ENV = {
  RETURN_REMINDERS_ENABLED: "true", TWILIO_TEMPLATE_SOUL_RETURN: "HXreturn-test",
  RETURN_REMINDERS_PUBLIC_BASE_URL: "https://clinic.example", CRON_SECRET: "isolated-secret",
  TWILIO_ACCOUNT_SID: `AC${"a".repeat(32)}`, TWILIO_AUTH_TOKEN: "isolated-auth",
  TWILIO_WHATSAPP_FROM: "whatsapp:+14155238886",
};
const appointment = (extra = {}) => ({ _id: new ObjectId(), date: "2026-07-23", time: "12:00", attended: true, ...extra });
let server, client, db, users, preferences, state, history, deps;

beforeAll(async () => {
  server = await MongoMemoryServer.create({ instance: { ip: "127.0.0.1", launchTimeout: 120_000 }, spawn: { windowsHide: true } });
  const uri = server.getUri();
  if (!uri.startsWith("mongodb://127.0.0.1:")) throw new Error("Expected loopback test MongoDB");
  client = new MongoClient(uri, { monitorCommands: true });
  await client.connect();
  db = client.db("return_reminder_sender_test");
}, 120_000);
afterAll(async () => { await client?.close(); await server?.stop(); });
beforeEach(async () => {
  await db.dropDatabase();
  users = db.collection("usersData");
  preferences = db.collection("returnReminderPreferences");
  state = db.collection("returnReminderState");
  history = db.collection("returnReminderHistory");
  deps = { env: { ...ENV }, clock: { now: () => NOW }, getCollection: async (name) => db.collection(name), sendWhatsAppTemplate: vi.fn(async () => ({ sid: "SMisolated" })) };
});

async function customer(appointments = [appointment()], extra = {}) {
  const user = { _id: new ObjectId(), phone: PHONE, firstName: "زبون", lastName: "تجريبي", appointments, ...extra };
  await users.insertOne(user);
  return user;
}
async function permit(phone = PHONE) { await preferences.updateOne({ _id: phone }, { $set: { enabled: true } }, { upsert: true }); }
async function enabledCustomer(appointments, extra) { const user = await customer(appointments, extra); await permit(user.phone); return user; }
function intercept(collectionName, method, replacement) {
  const getCollection = deps.getCollection;
  deps.getCollection = async (name) => {
    const collection = await getCollection(name);
    if (name !== collectionName) return collection;
    return new Proxy(collection, { get(target, key) {
      if (key === method) return (...args) => replacement(target, args);
      return typeof target[key] === "function" ? target[key].bind(target) : target[key];
    } });
  };
}

describe("calendar eligibility", () => {
  it.each([
    ["2026-07-23", "12:00", "2026-10-23T08:59:59Z", false],
    ["2026-07-23", "12:00", "2026-10-23T09:00:00Z", true],
    ["2026-01-31", "12:00", "2026-04-30T08:59:59Z", false],
    ["2026-01-31", "12:00", "2026-04-30T09:00:00Z", true],
    ["2025-11-30", "12:00", "2026-02-28T10:00:00Z", true],
    ["2023-11-30", "12:00", "2024-02-29T09:59:59Z", false],
    ["2023-11-30", "12:00", "2024-02-29T10:00:00Z", true],
    ["2026-07-25", "12:00", "2026-10-25T09:59:59Z", false],
    ["2026-07-25", "12:00", "2026-10-25T10:00:00Z", true],
    ["2026-07-24", "00:00", "2026-10-23T21:00:00Z", true],
  ])("uses three clamped Israel calendar months: %s %s at %s", (date, time, now, eligible) => {
    expect(getReturnReminderEligibility({ appointments: [appointment({ date, time })], now: new Date(now) }).eligible).toBe(eligible);
  });

  it("uses the latest attended treatment, ignoring newer no-shows and unconfirmed history", () => {
    const latest = appointment({ date: "2026-07-23" });
    const appointments = [appointment({ date: "2026-01-01" }), appointment({ date: "2026-10-01", attended: false }), latest,
      appointment({ date: "2026-10-22", attended: undefined })];
    expect(getReturnReminderEligibility({ appointments, now: NOW })).toMatchObject({ eligible: true, lastAttended: latest });
    expect(getReturnReminderEligibility({ appointments: [...appointments, appointment({ date: "2026-08-01" })], now: NOW }).eligible).toBe(false);
  });

  it.each([
    [], [appointment({ attended: false })], [appointment({ attended: "true" })], [appointment({ date: "2026-02-30" })],
    [appointment(), appointment({ date: "2026-10-23", time: "12:00", attended: false })],
    [appointment(), appointment({ date: "2026-11-01", attended: false, treatmentPlanId: new ObjectId() })],
    [appointment(), appointment({ date: "2026-11-01", time: null })],
    [appointment(), appointment({ date: null })], [appointment(), null],
  ])("excludes missing attendance, current/future bookings and unknown schedules %#", (...args) => {
    // Vitest spreads array rows; restore the appointments fixture without changing its values.
    expect(getReturnReminderEligibility({ appointments: args, now: NOW }).eligible).toBe(false);
  });

  it("fails closed when malformed attended history could conceal more recent care", () => {
    expect(getReturnReminderEligibility({ appointments: [appointment(), appointment({ date: "2026-08-01", time: "bad" })], now: NOW }).eligible).toBe(false);
  });

  it("ignores malformed historical times on non-attended appointments", () => {
    expect(getReturnReminderEligibility({ appointments: [appointment(), appointment({ date: "2026-08-01", time: "bad", attended: false })], now: NOW }).eligible).toBe(true);
  });
});

describe("durable monthly return dispatch", () => {
  it("sends to existing and newly added eligible customers by default without fabricating consent records", async () => {
    await customer();
    expect((await sendDueReturnReminders({ now: NOW }, deps)).sent).toBe(1);
    await customer(undefined, { phone: "+972531234567" });
    expect((await sendDueReturnReminders({ now: NOW }, deps)).sent).toBe(1);
    expect(deps.sendWhatsAppTemplate).toHaveBeenCalledTimes(2);
    expect(await preferences.countDocuments()).toBe(0);
  });

  it("keeps unrecognized disabled and malformed stored preferences off until explicitly enabled", async () => {
    await customer();
    for (const enabled of [undefined, false, "true"]) {
      await preferences.replaceOne({ _id: PHONE }, enabled === undefined ? { _id: PHONE } : { _id: PHONE, enabled }, { upsert: true });
      expect((await sendDueReturnReminders({ now: NOW }, deps)).sent).toBe(0);
    }
    expect(await state.countDocuments()).toBe(0);
    await permit();
    expect((await sendDueReturnReminders({ now: NOW }, deps)).sent).toBe(1);
  });

  it("sends after the one-time renewed consent while preserving old preference history", async () => {
    await customer();
    const prior = { _id: PHONE, enabled: false, source: "unsubscribe_link", updatedAt: NOW, disabledAt: NOW };
    await preferences.insertOne(prior);
    expect((await sendDueReturnReminders({ now: NOW }, deps)).sent).toBe(1);
    expect(await preferences.findOne({ _id: PHONE })).toEqual(prior);
  });

  it("keeps a legacy opt-out newer than renewed consent off", async () => {
    await customer();
    await preferences.insertOne({ _id: PHONE, enabled: false, source: "whatsapp", updatedAt: new Date("2026-10-23T15:27:08.001Z") });
    expect((await sendDueReturnReminders({ now: NOW }, deps)).sent).toBe(0);
    expect(await state.countDocuments()).toBe(0);
  });

  it("sends four variables, stores only an opaque token digest and retains immutable attempt history", async () => {
    const user = await enabledCustomer(undefined, { firstName: "اسم\nأول" });
    const result = await sendDueReturnReminders({ now: NOW }, deps);
    expect(result).toMatchObject({ status: "completed", sent: 1, unknown: 0 });
    const message = deps.sendWhatsAppTemplate.mock.calls[0][0];
    expect(message).toMatchObject({ to: `whatsapp:${PHONE}`, templateSid: ENV.TWILIO_TEMPLATE_SOUL_RETURN,
      variables: { 1: "اسم أول تجريبي", 2: "2026-07-23", 3: "https://clinic.example/dashboard" } });
    expect(Object.keys(message.variables)).toHaveLength(4);
    const token = message.variables[4].split("/").pop();
    expect(message.variables[4]).toBe(`https://clinic.example/reminders/unsubscribe/${token}`);
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const saved = await history.findOne({});
    expect(saved).toMatchObject({ phone: PHONE, userId: user._id, tokenHash: createHash("sha256").update(token).digest("hex"), claimedAt: NOW,
      lastAttended: { date: "2026-07-23", time: "12:00" }, dispatch: { status: "sent", providerSid: "SMisolated" } });
    expect(saved._id).toBeInstanceOf(ObjectId);
    expect(JSON.stringify({ saved, result, state: await state.findOne({}) })).not.toContain(token);
    expect(saved.expiresAt).toBeUndefined();
  });

  it("enforces exactly thirty elapsed days across DST and has no fixed repeat cap", async () => {
    await enabledCustomer();
    expect((await sendDueReturnReminders({ now: NOW }, deps)).sent).toBe(1);
    expect((await state.findOne({ _id: PHONE })).nextAttemptAt.toISOString()).toBe("2026-11-22T09:00:00.000Z");
    expect((await sendDueReturnReminders({ now: new Date("2026-11-22T08:59:59.999Z") }, deps)).sent).toBe(0);
    for (let cycle = 1; cycle <= 4; cycle++) {
      expect((await sendDueReturnReminders({ now: new Date(NOW.getTime() + cycle * 30 * 86400000) }, deps)).sent).toBe(1);
    }
    expect(await history.countDocuments()).toBe(5);
    expect(new Set((await history.find().toArray()).map((entry) => entry.tokenHash)).size).toBe(5);
  });

  it("coalesces concurrent workers and differently formatted duplicate customer phones", async () => {
    await customer();
    for (const phone of ["052-123-4567", "00972 (52) 123 4567", "972521234567", 972521234567]) await customer(undefined, { phone });
    await Promise.all(Array.from({ length: 6 }, () => sendDueReturnReminders({ now: NOW }, deps)));
    expect(deps.sendWhatsAppTemplate).toHaveBeenCalledTimes(1);
    expect(await state.countDocuments()).toBe(1);
    expect(await history.countDocuments()).toBe(1);
    expect(await preferences.countDocuments()).toBe(0);
  });

  it("counts one default-enabled phone once in dry-run despite duplicate customer formats", async () => {
    for (const phone of [PHONE, "052-123-4567", "00972 (52) 123 4567", "972521234567", 972521234567]) await customer(undefined, { phone });
    expect(await sendDueReturnReminders({ now: NOW, dryRun: true }, deps)).toMatchObject({ eligible: 1, sent: 0 });
    expect(await preferences.countDocuments()).toBe(0);
  });

  it("skips a malformed phone object without starving a later eligible customer", async () => {
    await customer(undefined, { phone: { toString: null } });
    await customer();
    expect(await sendDueReturnReminders({ now: NOW }, deps)).toMatchObject({ sent: 1, failed: 0, unknown: 0 });
    expect(deps.sendWhatsAppTemplate).toHaveBeenCalledTimes(1);
    expect(deps.sendWhatsAppTemplate.mock.calls[0][0].to).toBe(`whatsapp:${PHONE}`);
  });

  it.each(["upcoming", "recent attendance", "missing schedule"])("another matching account blocks the earlier selected account: %s", async (reason) => {
    await enabledCustomer();
    await customer(reason === "upcoming" ? [appointment({ date: "2026-11-01", attended: false })] :
      reason === "recent attendance" ? [appointment({ date: "2026-09-01" })] : null, { phone: "00 972 (52) 123-4567" });
    expect((await sendDueReturnReminders({ now: NOW }, deps)).sent).toBe(0);
    expect(await state.countDocuments()).toBe(0);
  });

  it("blocks a calendar-only plan booking and permits canceled appointments removed from both stores", async () => {
    await enabledCustomer();
    await db.collection("appointments").insertOne({ date: "2026-12-01", appointments: [{ phone: "052-123-4567", time: "13:00", treatmentPlanId: new ObjectId() }] });
    expect((await sendDueReturnReminders({ now: NOW }, deps)).sent).toBe(0);
    await db.collection("appointments").deleteMany({});
    expect((await sendDueReturnReminders({ now: NOW }, deps)).sent).toBe(1);
  });

  it.each(["booking", "duplicate booking", "attendance", "opt-out", "contact"])("rechecks %s after claiming and consumes the cooldown", async (change) => {
    const user = await enabledCustomer();
    intercept("returnReminderState", "findOneAndUpdate", async (target, args) => {
      const claim = await target.findOneAndUpdate(...args);
      if (change === "booking") await users.updateOne({ _id: user._id }, { $push: { appointments: appointment({ date: "2026-11-01", attended: false }) } });
      if (change === "duplicate booking") await customer([appointment({ date: "2026-11-01", attended: false })], { phone: "052 123 4567" });
      if (change === "attendance") await users.updateOne({ _id: user._id }, { $push: { appointments: appointment({ date: "2026-10-22" }) } });
      if (change === "opt-out") await preferences.updateOne({ _id: PHONE }, { $set: { enabled: false } });
      if (change === "contact") await users.updateOne({ _id: user._id }, { $set: { phone: "+972599999999" } });
      return claim;
    });
    const result = await sendDueReturnReminders({ now: NOW }, deps);
    expect(result).toMatchObject({ sent: 0, skipped: 1 });
    expect(deps.sendWhatsAppTemplate).not.toHaveBeenCalled();
    expect((await history.findOne({})).dispatch.status).toBe("canceled");
    expect((await state.findOne({})).nextAttemptAt).toEqual(new Date("2026-11-22T09:00:00.000Z"));
  });

  it("rechecks after history persistence immediately before provider dispatch", async () => {
    await enabledCustomer();
    intercept("returnReminderHistory", "insertOne", async (target, args) => {
      const inserted = await target.insertOne(...args);
      await preferences.updateOne({ _id: PHONE }, { $set: { enabled: false } });
      return inserted;
    });
    expect((await sendDueReturnReminders({ now: NOW }, deps)).sent).toBe(0);
    expect(deps.sendWhatsAppTemplate).not.toHaveBeenCalled();
  });

  it("honors a fresh opt-out of a default-enabled phone in the final permission read", async () => {
    await customer();
    intercept("returnReminderState", "updateOne", async (target, args) => {
      const updated = await target.updateOne(...args);
      if (args[1].$set?.dispatchStartedAt) {
        await optOutReturnRemindersByPhone({ phone: PHONE, now: NOW }, { getCollection: async (name) => db.collection(name) });
      }
      return updated;
    });
    expect(await sendDueReturnReminders({ now: NOW }, deps)).toMatchObject({ sent: 0, skipped: 1 });
    expect(deps.sendWhatsAppTemplate).not.toHaveBeenCalled();
    expect((await history.findOne({})).dispatch.status).toBe("canceled");
    expect((await preferences.findOne({ _id: PHONE })).enabled).toBe(false);
  });

  it("does not dispatch a stale process whose claim was superseded", async () => {
    await enabledCustomer();
    const replacementId = new ObjectId();
    intercept("returnReminderHistory", "insertOne", async (target, args) => {
      const inserted = await target.insertOne(...args);
      await state.updateOne({ _id: PHONE }, { $set: { attemptId: replacementId } });
      return inserted;
    });
    expect((await sendDueReturnReminders({ now: NOW }, deps)).sent).toBe(0);
    expect(deps.sendWhatsAppTemplate).not.toHaveBeenCalled();
    expect((await state.findOne({})).attemptId).toEqual(replacementId);
  });

  it("extends the cooldown through delayed provider completion using elapsed time", async () => {
    await enabledCustomer();
    let elapsed = 0;
    deps.clock = { now: () => new Date(NOW.getTime() + elapsed) };
    deps.sendWhatsAppTemplate.mockImplementation(async () => { elapsed += 60000; return { sid: "SMlate" }; });
    expect((await sendDueReturnReminders({ now: NOW }, deps)).sent).toBe(1);
    expect((await state.findOne({})).nextAttemptAt.toISOString()).toBe("2026-11-22T09:01:00.000Z");
    expect((await sendDueReturnReminders({ now: new Date("2026-11-22T09:00:00Z") }, deps)).sent).toBe(0);
  });

  it.each(["claim", "history"])("never dispatches after ambiguous %s persistence", async (failure) => {
    await enabledCustomer();
    const name = failure === "claim" ? "returnReminderState" : "returnReminderHistory";
    const method = failure === "claim" ? "findOneAndUpdate" : "insertOne";
    intercept(name, method, async (target, args) => { await target[method](...args); throw new Error("acknowledgement lost"); });
    await expect(sendDueReturnReminders({ now: NOW }, deps)).rejects.toThrow();
    deps.getCollection = async (name) => db.collection(name);
    await sendDueReturnReminders({ now: NOW }, deps);
    expect(deps.sendWhatsAppTemplate).not.toHaveBeenCalled();
    expect(await state.countDocuments()).toBe(1);
  });

  it.each([undefined, 408, 500, 400])("consumes cooldown on provider outcome %s without leaking errors or retrying", async (status) => {
    await enabledCustomer();
    deps.sendWhatsAppTemplate.mockImplementation(async ({ variables }) => { throw Object.assign(new Error(`secret ${variables[4]}`), { status }); });
    const result = await sendDueReturnReminders({ now: NOW }, deps);
    expect(result[status === 400 ? "failed" : "unknown"]).toBe(1);
    await sendDueReturnReminders({ now: NOW }, deps);
    expect(deps.sendWhatsAppTemplate).toHaveBeenCalledTimes(1);
    expect(JSON.stringify({ result, record: await history.findOne({}) })).not.toMatch(/secret|https/);
  });

  it("keeps the claim when the provider succeeded but outcome persistence failed", async () => {
    await enabledCustomer();
    intercept("returnReminderHistory", "updateOne", async () => { throw new Error("storage unavailable"); });
    expect((await sendDueReturnReminders({ now: NOW }, deps)).unknown).toBe(1);
    await sendDueReturnReminders({ now: NOW }, deps);
    expect(deps.sendWhatsAppTemplate).toHaveBeenCalledTimes(1);
    expect((await history.findOne({})).dispatch.status).toBe("claimed");
  });

  it("requires durable acknowledgement before any provider call", async () => {
    await enabledCustomer();
    const writes = [];
    const listener = ({ command }) => {
      if ([command.findAndModify, command.insert, command.update].some((name) => ["returnReminderState", "returnReminderHistory"].includes(name))) writes.push(command);
    };
    client.on("commandStarted", listener);
    try {
      await sendDueReturnReminders({ now: NOW }, deps);
      expect(writes).toHaveLength(5);
      for (const write of writes) expect(write.writeConcern?.w).toBe("majority");
    } finally { client.off("commandStarted", listener); }
  });

  it("bounds actual dispatches and continues past cooled, ineligible and malformed candidates", async () => {
    for (let index = 0; index < 130; index++) {
      const phone = `+9725${String(index).padStart(8, "0")}`;
      await customer(index >= 40 && index < 75 ? [] : undefined, { phone: index < 10 ? `invalid-${index}` : phone });
      if (index >= 10 && index < 20) await state.insertOne({ _id: phone, nextAttemptAt: new Date("2026-11-01T09:00:00Z") });
      if (index >= 20 && index < 40) await preferences.insertOne({ _id: phone, enabled: index < 30 ? false : "true" });
    }
    expect((await sendDueReturnReminders({ now: NOW }, deps)).sent).toBe(50);
    expect((await sendDueReturnReminders({ now: NOW }, deps)).sent).toBe(5);
    expect(deps.sendWhatsAppTemplate).toHaveBeenCalledTimes(55);
    expect(new Set(deps.sendWhatsAppTemplate.mock.calls.map(([message]) => message.to)).size).toBe(55);
  });

  it("dry-run inspects due permission/cooldown without creating indexes, claims or history", async () => {
    await enabledCustomer();
    const mutations = [];
    const listener = ({ commandName }) => { if (["insert", "update", "findAndModify", "createIndexes"].includes(commandName)) mutations.push(commandName); };
    client.on("commandStarted", listener);
    try {
      const result = await sendDueReturnReminders({ now: NOW, dryRun: true }, deps);
      expect(result).toMatchObject({ eligible: 1, sent: 0, dryRun: true });
      expect(mutations).toEqual([]);
      expect(JSON.stringify(result)).not.toMatch(/972|زبون|token/);
    } finally { client.off("commandStarted", listener); }
    expect(await state.countDocuments()).toBe(0);
    expect(await history.countDocuments()).toBe(0);
    expect(deps.sendWhatsAppTemplate).not.toHaveBeenCalled();
  });

  it("is disabled until every required explicit configuration is present", async () => {
    for (const env of [{}, { ...ENV, RETURN_REMINDERS_ENABLED: "false" },
      ...["CRON_SECRET", "TWILIO_TEMPLATE_SOUL_RETURN", "TWILIO_ACCOUNT_SID", "TWILIO_AUTH_TOKEN", "TWILIO_WHATSAPP_FROM"].map((key) => ({ ...ENV, [key]: "" })),
      ...["http://clinic.example", "https://localhost", "https://127.0.0.1", "https://user:pass@clinic.example", "https://clinic.example/path", "https://clinic.example?x=1"].map((url) => ({ ...ENV, RETURN_REMINDERS_PUBLIC_BASE_URL: url }))]) {
      const getCollection = vi.fn(() => { throw new Error("Must not access database"); });
      expect(["disabled", "not_configured"]).toContain((await sendDueReturnReminders({ now: NOW }, { ...deps, env, getCollection })).status);
      expect(getCollection).not.toHaveBeenCalled();
    }
  });
});
