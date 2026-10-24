import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { MongoClient, ObjectId } from "mongodb";
import { MongoMemoryReplSet } from "mongodb-memory-server-core";

vi.mock("@/lib/db", () => { throw new Error("Live database forbidden"); });
vi.mock("@/lib/whatsapp", () => { throw new Error("Live WhatsApp forbidden"); });
const worker = await import("@/lib/adminDailyReports").catch(() => ({}));
const run = (...args) => { expect(worker.runDailyAdminReports).toBeTypeOf("function"); return worker.runDailyAdminReports(...args); };
const NOW = new Date("2026-10-25T19:00:00Z"); // 21:00 after Jerusalem's autumn clock change.
const oid = n => new ObjectId(n.toString(16).padStart(24, "0"));
let server, client, db, deps, serial = 0;
beforeAll(async () => {
  server = await MongoMemoryReplSet.create({ instanceOpts: [{ launchTimeout: 120000 }], replSet: { count: 1, ip: "127.0.0.1", storageEngine: "wiredTiger", spawn: { windowsHide: true } } });
  const uri = server.getUri();
  if (!uri.startsWith("mongodb://127.0.0.1:")) throw new Error("Loopback only");
  client = await new MongoClient(uri).connect();
}, 120000);
afterAll(async () => { await client?.close(); await server?.stop(); }, 120000);
beforeEach(async () => {
  db = client.db(`admin_reports_${++serial}`);
  deps = {
    client, getCollection: async name => db.collection(name),
    env: { TWILIO_TEMPLATE_TOMORROW_APPOINTMENTS: "HXappointments", TWILIO_TEMPLATE_FEEDBACK: "HXfeedback",
      TWILIO_WHATSAPP_TO: "whatsapp:+972521234567", TWILIO_WHATSAPP_FROM: "whatsapp:+972529876543",
      TWILIO_ACCOUNT_SID: "ACtest", TWILIO_AUTH_TOKEN: "test", CRON_SECRET: "test" },
    sendWhatsAppTemplate: vi.fn(async () => ({ sid: "SMtest", status: "queued" })),
  };
});

async function seed() {
  await db.collection("usersData").insertOne({ _id: oid(1), firstName: "أحمد", lastName: "علي", phone: "+972500000000",
    appointments: [
      { _id: oid(11), date: "2026-10-26", time: "10:30", title: "حجامة", attended: false },
      { _id: oid(12), date: "2026-10-26", time: "12:00", title: "إبر صينية", attended: true },
      { _id: oid(21), date: "2026-10-18", time: "10:00", title: "حجامة", attended: true },
      { _id: oid(22), date: "2026-10-18", time: "11:00", title: "إبر صينية", attended: true },
    ] });
  await db.collection("appointments").insertOne({ date: "2026-10-26", appointments: [
    { _id: oid(12), firstName: "أحمد", lastName: "علي", phone: "+972500000000", time: "12:00" },
    { _id: oid(11), firstName: "أحمد", lastName: "علي", phone: "+972500000000", time: "10:30" },
  ] });
  await addFeedback(21, "2026-10-25T17:00:00Z");
}
async function addFeedback(id, submittedAt, text = "خفّ الوجع كثير", score = 8) {
  await db.collection("appointmentFeedback").insertOne({ _id: oid(id), appointmentId: oid(id), userId: oid(1),
    feedback: { submittedAt: new Date(submittedAt), text, ...(score === undefined ? {} : { painRelief: score }) } });
}

describe("daily admin reports", () => {
  it("sends one whole numbered list per template to the existing admin recipient", async () => {
    await seed();
    const result = await run({ now: NOW }, deps);
    expect(result).toMatchObject({ status: "completed", date: "2026-10-25", tomorrow: "2026-10-26",
      appointments: { status: "sent", count: 2 }, feedback: { status: "sent", count: 1 } });
    expect(deps.sendWhatsAppTemplate).toHaveBeenCalledTimes(2);
    const messages = deps.sendWhatsAppTemplate.mock.calls.map(([message]) => message);
    expect(messages.every(message => message.to === "whatsapp:+972521234567")).toBe(true);
    expect(messages.map(message => message.templateSid)).toEqual(["HXappointments", "HXfeedback"]);
    expect(Object.keys(messages[0].variables)).toEqual(["1"]);
    expect(messages[0].variables[1]).toContain("1) أحمد علي");
    expect(messages[0].variables[1]).toContain("حجامة | 10:30 ║ 2)");
    expect(messages[0].variables[1]).toContain("إبر صينية | 12:00");
    expect(messages[1].variables[1]).toContain("8/10 | خفّ الوجع كثير");
    expect(JSON.stringify(result)).not.toMatch(/أحمد|خفّ|972521234567|SMtest/);
    expect(await db.collection("adminDailyReports").countDocuments({ status: "sent" })).toBe(2);
    expect(await db.collection("adminDailyReportFeedback").countDocuments()).toBe(1);
  });

  it("does not send again on repeated or simultaneous runs", async () => {
    await seed();
    await Promise.all(Array.from({ length: 4 }, () => run({ now: NOW }, deps)));
    await run({ now: NOW }, deps);
    expect(deps.sendWhatsAppTemplate).toHaveBeenCalledTimes(2);
    expect(await db.collection("adminDailyReports").countDocuments()).toBe(2);
  });

  it("reserves feedback across report dates while the earlier send is still in flight", async () => {
    await seed();
    let entered, release;
    const sending = new Promise(resolve => { entered = resolve; });
    const hold = new Promise(resolve => { release = resolve; });
    let paused = false;
    deps.sendWhatsAppTemplate.mockImplementation(async message => {
      if (!paused && message.templateSid === "HXfeedback") { paused = true; entered(); await hold; }
      return { sid: "SMaccepted" };
    });
    const first = run({ now: NOW }, deps);
    await sending;
    try {
      const second = await run({ now: new Date("2026-10-26T19:00:00Z") }, deps);
      expect(second.feedback).toMatchObject({ status: "sent", count: 0 });
    } finally { release(); }
    expect((await first).feedback).toMatchObject({ status: "sent", count: 1 });
    const feedbackMessages = deps.sendWhatsAppTemplate.mock.calls.filter(([message]) => message.templateSid === "HXfeedback");
    expect(feedbackMessages).toHaveLength(2);
    expect(feedbackMessages.filter(([message]) => message.variables[1].includes("خفّ الوجع كثير"))).toHaveLength(1);
  });

  it("does not read or send before21:00, and ignores missing configuration without consuming a claim", async () => {
    const read = vi.fn(() => { throw new Error("Unexpected read"); });
    expect(await run({ now: new Date("2026-10-25T18:59:59Z") }, { ...deps, getCollection: read })).toMatchObject({ status: "not_due" });
    for (const key of ["TWILIO_TEMPLATE_TOMORROW_APPOINTMENTS", "TWILIO_TEMPLATE_FEEDBACK", "TWILIO_WHATSAPP_TO", "CRON_SECRET"]) {
      expect(await run({ now: NOW }, { ...deps, getCollection: read, env: { ...deps.env, [key]: " " } })).toMatchObject({ status: "not_configured" });
    }
    expect(read).not.toHaveBeenCalled();
    expect(deps.sendWhatsAppTemplate).not.toHaveBeenCalled();
  });

  it("dry run previews counts before the send hour without writes, indexes, or sends", async () => {
    await seed();
    const before = await db.listCollections({}, { nameOnly: true }).toArray();
    const result = await run({ now: new Date("2026-10-25T18:00:00Z"), dryRun: true }, deps);
    expect(result).toMatchObject({ status: "completed", dryRun: true, appointments: { status: "ready", count: 2 }, feedback: { status: "ready", count: 1 } });
    expect(await db.listCollections({}, { nameOnly: true }).toArray()).toEqual(before);
    expect(await db.collection("appointmentFeedback").indexes()).toHaveLength(1);
    expect(deps.sendWhatsAppTemplate).not.toHaveBeenCalled();
  });

  it("anchors the first report at the previous local21:00 across DST and excludes the current cutoff", async () => {
    await seed();
    await addFeedback(22, "2026-10-24T17:59:59.999Z", "قبل البداية");
    await addFeedback(23, "2026-10-24T18:00:00Z", "بداية الفترة");
    await addFeedback(24, "2026-10-25T18:59:59.999Z", "قبل النهاية");
    await addFeedback(25, "2026-10-25T19:00:00Z", "عند النهاية");
    await run({ now: NOW }, deps);
    const text = deps.sendWhatsAppTemplate.mock.calls[1][0].variables[1];
    expect(text).toContain("بداية الفترة");
    expect(text).toContain("قبل النهاية");
    expect(text).not.toContain("قبل البداية");
    expect(text).not.toContain("عند النهاية");
    const state = await db.collection("adminDailyReportState").findOne({ _id: "feedback" });
    expect(state.from).toEqual(new Date("2026-10-24T18:00:00Z"));
  });

  it("carries after-cutoff feedback, late writes, and missed days forward once", async () => {
    await seed();
    await run({ now: NOW }, deps);
    await addFeedback(22, "2026-10-25T19:00:00Z", "بعد التقرير");
    await addFeedback(23, "2026-10-25T18:59:59Z", "كتابة متأخرة");
    await addFeedback(24, "2026-10-26T14:00:00Z", "في يوم لم يعمل فيه التقرير");
    await run({ now: new Date("2026-10-27T19:00:00Z") }, deps);
    const text = deps.sendWhatsAppTemplate.mock.calls[3][0].variables[1];
    expect(text).toContain("بعد التقرير");
    expect(text).toContain("كتابة متأخرة");
    expect(text).toContain("في يوم لم يعمل فيه التقرير");
    expect(text).not.toContain("خفّ الوجع كثير");
    expect(await db.collection("adminDailyReportFeedback").countDocuments()).toBe(4);
  });

  it.each([
    ["2026-03-26T19:00:00Z", "2026-03-27"],
    ["2026-03-27T18:00:00Z", "2026-03-28"],
    ["2026-12-31T19:00:00Z", "2027-01-01"],
  ])("uses the next clinic calendar date at %s", async (now, tomorrow) => {
    expect(await run({ now: new Date(now), dryRun: true }, deps)).toMatchObject({ tomorrow });
  });

  it("sends concise empty reports", async () => {
    const result = await run({ now: NOW }, deps);
    expect(result).toMatchObject({ appointments: { count: 0, status: "sent" }, feedback: { count: 0, status: "sent" } });
    expect(deps.sendWhatsAppTemplate.mock.calls[0][0].variables[1]).toMatch(/لا توجد.*مواعيد/);
    expect(deps.sendWhatsAppTemplate.mock.calls[1][0].variables[1]).toMatch(/لا توجد.*تقييمات/);
  });

  it("keeps other reports working when one is too long; does not truncate, split, or consume feedback", async () => {
    await seed();
    await db.collection("appointmentFeedback").updateOne({ _id: oid(21) }, { $set: { "feedback.text": "طويل ".repeat(400) } });
    const result = await run({ now: NOW }, deps);
    expect(result).toMatchObject({ status: "partial", appointments: { status: "sent" }, feedback: { status: "too_long", count: 1 } });
    expect(deps.sendWhatsAppTemplate).toHaveBeenCalledTimes(1);
    expect(await db.collection("adminDailyReportFeedback").countDocuments()).toBe(0);
    expect(await db.collection("adminDailyReports").countDocuments({ type: "feedback" })).toBe(0);
  });

  it("retries explicit rejections safely but never repeats an already accepted report", async () => {
    await seed();
    deps.sendWhatsAppTemplate.mockImplementationOnce(async () => ({ sid: "SMappointments" }))
      .mockRejectedValueOnce(Object.assign(new Error("private rejection"), { status: 400, code: 63016 }));
    expect(await run({ now: NOW }, deps)).toMatchObject({ appointments: { status: "sent" }, feedback: { status: "failed" } });
    expect(await db.collection("adminDailyReportFeedback").countDocuments()).toBe(0);
    expect(await run({ now: NOW }, deps)).toMatchObject({ appointments: { status: "already_sent" }, feedback: { status: "sent" } });
    expect(deps.sendWhatsAppTemplate).toHaveBeenCalledTimes(3);
  });

  it.each([undefined, 408, 500])("does not retry uncertain delivery status %s, even on the next day", async status => {
    await seed();
    deps.sendWhatsAppTemplate.mockImplementationOnce(async () => ({ sid: "SMappointments" }))
      .mockRejectedValueOnce(Object.assign(new Error("private network failure"), { status }));
    expect(await run({ now: NOW }, deps)).toMatchObject({ feedback: { status: "unknown" } });
    await run({ now: NOW }, deps);
    expect(deps.sendWhatsAppTemplate).toHaveBeenCalledTimes(2);
    await run({ now: new Date("2026-10-26T19:00:00Z") }, deps);
    expect(deps.sendWhatsAppTemplate.mock.calls[3][0].variables[1]).not.toContain("خفّ الوجع كثير");
  });

  it("keeps a response without a message SID uncertain and never retries it", async () => {
    await seed();
    deps.sendWhatsAppTemplate.mockResolvedValueOnce({}).mockResolvedValueOnce({});
    expect(await run({ now: NOW }, deps)).toMatchObject({ appointments: { status: "unknown" }, feedback: { status: "unknown" } });
    await run({ now: NOW }, deps);
    expect(deps.sendWhatsAppTemplate).toHaveBeenCalledTimes(2);
    expect(await db.collection("adminDailyReportFeedback").countDocuments()).toBe(1);
  });

  it("does not resend after a post-send database failure", async () => {
    await seed();
    const realCollection = deps.getCollection;
    let failStatusWrites = false;
    deps.getCollection = async name => {
      const collection = await realCollection(name);
      if (name !== "adminDailyReports") return collection;
      return new Proxy(collection, { get(target, key) {
        if (key === "updateOne") return async (...args) => {
          if (failStatusWrites && args[1]?.$set?.completedAt) throw new Error("status write failed");
          return target.updateOne(...args);
        };
        return typeof target[key] === "function" ? target[key].bind(target) : target[key];
      } });
    };
    deps.sendWhatsAppTemplate.mockImplementationOnce(async () => {
      failStatusWrites = true;
      return { sid: "SMaccepted" };
    });
    const first = await run({ now: NOW }, deps);
    expect(first.appointments.status).toBe("unknown");
    deps.getCollection = realCollection;
    await run({ now: NOW }, deps);
    expect(deps.sendWhatsAppTemplate.mock.calls.filter(([message]) => message.templateSid === "HXappointments")).toHaveLength(1);
  });
});
