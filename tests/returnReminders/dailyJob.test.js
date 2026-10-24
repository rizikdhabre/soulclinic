import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { MongoClient, ObjectId } from "mongodb";
import { MongoMemoryServer } from "mongodb-memory-server-core";
import { runDailyReturnReminders } from "@/lib/returnReminderDailyJob";

vi.mock("@/lib/db", () => ({ getCollection: () => { throw new Error("Live database forbidden"); } }));
vi.mock("@/lib/whatsapp", () => ({ sendWhatsAppTemplate: () => { throw new Error("Live messages forbidden"); } }));
const NOW = new Date("2026-10-24T16:00:00Z");
let server, client, db, deps;
beforeAll(async () => {
  server = await MongoMemoryServer.create({ instance: { ip: "127.0.0.1", launchTimeout: 120000 }, spawn: { windowsHide: true } });
  if (!server.getUri().startsWith("mongodb://127.0.0.1:")) throw new Error("Loopback only");
  client = new MongoClient(server.getUri());
  await client.connect();
  db = client.db("daily_return_test");
}, 120000);
afterAll(async () => { await client?.close(); await server?.stop(); });
beforeEach(async () => {
  await db.dropDatabase();
  deps = {
    env: { RETURN_REMINDERS_ENABLED: "true", TWILIO_TEMPLATE_SOUL_RETURN: "HXtest", RETURN_REMINDERS_PUBLIC_BASE_URL: "https://clinic.example",
      CRON_SECRET: "test", TWILIO_ACCOUNT_SID: "ACtest", TWILIO_AUTH_TOKEN: "test", TWILIO_WHATSAPP_FROM: "whatsapp:+14155238886" },
    clock: { now: () => NOW }, getCollection: async name => db.collection(name),
    sendWhatsAppTemplate: vi.fn(async () => ({ sid: "SMtest" })),
  };
});
async function seed(count) {
  await db.collection("usersData").insertMany(Array.from({ length: count }, (_, index) => ({
    _id: new ObjectId(), phone: `+9725${String(index).padStart(8, "0")}`, firstName: "Test", lastName: "Customer",
    appointments: [{ _id: new ObjectId(), date: "2026-01-01", time: "12:00", attended: true }],
  })));
}
describe("bounded daily reminder processing", () => {
  it("processes beyond50 customers in one daily invocation and does not resend on repeat", async () => {
    await seed(65);
    expect(await runDailyReturnReminders({ now: NOW }, deps)).toMatchObject({ status: "completed", sent: 65, continuationPending: false });
    expect((await runDailyReturnReminders({ now: NOW }, deps)).sent).toBe(0);
    expect(deps.sendWhatsAppTemplate).toHaveBeenCalledTimes(65);
  });
  it("persists a partial cursor and resumes without duplicating accepted messages", async () => {
    await seed(65);
    let elapsed = 0;
    deps.clock = { now: () => new Date(NOW.getTime() + elapsed) };
    deps.sendWhatsAppTemplate.mockImplementation(async () => { elapsed += 10000; return { sid: "SMtest" }; });
    const first = await runDailyReturnReminders({ now: NOW }, deps);
    expect(first).toMatchObject({ status: "partial", continuationPending: true });
    expect(first.sent).toBeGreaterThan(0);
    expect(first.sent).toBeLessThan(65);
    const progress = await db.collection("returnReminderJobs").findOne({ _id: "daily" });
    expect(progress.cursor).toMatch(/^[a-f\d]{24}$/);
    deps.sendWhatsAppTemplate.mockImplementation(async () => ({ sid: "SMtest" }));
    const second = await runDailyReturnReminders({ now: new Date(NOW.getTime() + elapsed) }, deps);
    expect(second.status).toBe("completed");
    expect(first.sent + second.sent).toBe(65);
    expect(new Set(deps.sendWhatsAppTemplate.mock.calls.map(([message]) => message.to)).size).toBe(65);
  });
  it("allows one concurrent scanner while retaining per-phone protection", async () => {
    await seed(4);
    let entered, release;
    const sending = new Promise(resolve => { entered = resolve; });
    const hold = new Promise(resolve => { release = resolve; });
    deps.sendWhatsAppTemplate.mockImplementationOnce(async () => { entered(); await hold; return { sid: "SMtest" }; });
    const first = runDailyReturnReminders({ now: NOW }, deps);
    await sending;
    let competing;
    try {
      competing = await Promise.all(Array.from({ length: 2 }, () => runDailyReturnReminders({ now: NOW }, deps)));
    } finally { release(); }
    expect((await first).sent).toBe(4);
    expect(competing.map(result => result.status)).toEqual(["busy", "busy"]);
    expect(deps.sendWhatsAppTemplate).toHaveBeenCalledTimes(4);
  });
  it("dry-run creates no claims, job cursor, indexes or messages", async () => {
    await seed(65);
    expect(await runDailyReturnReminders({ now: NOW, dryRun: true }, deps)).toMatchObject({ status: "completed", eligible: 65, sent: 0 });
    expect(await db.collection("returnReminderJobs").countDocuments()).toBe(0);
    expect(await db.collection("returnReminderState").countDocuments()).toBe(0);
    expect(await db.collection("returnReminderHistory").countDocuments()).toBe(0);
    expect(deps.sendWhatsAppTemplate).not.toHaveBeenCalled();
  });
  it("does not read the database while disabled", async () => {
    deps.env.RETURN_REMINDERS_ENABLED = "false";
    deps.getCollection = vi.fn(() => { throw new Error("Unexpected database read"); });
    expect(await runDailyReturnReminders({ now: NOW }, deps)).toMatchObject({ status: "disabled", sent: 0 });
    expect(deps.getCollection).not.toHaveBeenCalled();
  });
});
