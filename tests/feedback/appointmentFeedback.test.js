import { createHash } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { MongoClient, ObjectId } from "mongodb";
import { MongoMemoryServer } from "mongodb-memory-server-core";
import { getFeedbackRequest, submitAppointmentFeedback, sendDueFeedbackRequests } from "@/lib/appointmentFeedback";

vi.mock("@/lib/db", () => ({
  getCollection: () => { throw new Error("Application database access forbidden"); },
}));
vi.mock("@/lib/whatsapp", () => ({
  sendWhatsAppTemplate: () => { throw new Error("Real messages forbidden"); },
}));

const NOW = new Date("2026-10-23T09:00:00.000Z"); // Friday, 12:00 Israel
const ENV = {
  FEEDBACK_REQUESTS_ENABLED: "true",
  TWILIO_TEMPLATE_SOUL_TREATMENT_FEEDBACK: "HXfeedback-test",
  FEEDBACK_PUBLIC_BASE_URL: "https://clinic.example",
  CRON_SECRET: "test-cron-secret",
  TWILIO_ACCOUNT_SID: `AC${"a".repeat(32)}`,
  TWILIO_AUTH_TOKEN: "isolated-test-auth-token",
  TWILIO_WHATSAPP_FROM: "whatsapp:+14155238886",
};
let server, client, db, users, feedback, deps;

beforeAll(async () => {
  server = await MongoMemoryServer.create({
    instance: { ip: "127.0.0.1", launchTimeout: 120_000 },
    spawn: { windowsHide: true },
  });
  const uri = server.getUri();
  if (!uri.startsWith("mongodb://127.0.0.1:")) throw new Error("Expected loopback test MongoDB");
  client = new MongoClient(uri, { monitorCommands: true });
  await client.connect();
  db = client.db("appointment_feedback_test");
}, 120_000);

afterAll(async () => {
  await client?.close();
  await server?.stop();
});

beforeEach(async () => {
  await db.dropDatabase();
  users = db.collection("usersData");
  feedback = db.collection("appointmentFeedback");
  deps = {
    env: { ...ENV },
    getCollection: async (name) => db.collection(name),
    sendWhatsAppTemplate: vi.fn(async () => ({ sid: "SMtest" })),
  };
});

async function customer(appointments, extra = {}) {
  const user = {
    _id: new ObjectId(), firstName: "زبون", lastName: "تجريبي", phone: "+972521234567",
    adminNotes: [{ text: "private note" }],
    appointments: appointments.map((a) => ({
      _id: new ObjectId(), title: "حجامة", date: "2026-10-16", time: "12:00", attended: true, ...a,
    })),
    ...extra,
  };
  await users.insertOne(user);
  return user;
}

function deliveredToken(index = 0) {
  const url = deps.sendWhatsAppTemplate.mock.calls[index][0].variables[4];
  return new URL(url).pathname.split("/").pop();
}

async function issue() {
  const user = await customer([{}]);
  await sendDueFeedbackRequests({ now: NOW }, deps);
  return { user, token: deliveredToken(), appointmentId: user.appointments[0]._id };
}

describe("feedback eligibility and durable dispatch", () => {
  it("sends only attended appointments between seven and thirty Israel calendar days, including exact boundaries", async () => {
    await customer([
      { title: "seven-day boundary" },
      { date: "2026-09-23", title: "thirty-day boundary" },
      { time: "12:01", title: "not seven days yet" },
      { date: "2026-09-23", time: "11:59", title: "too old" },
      { date: "2026-10-24", title: "future" },
      { date: "2026-10-01", attended: false, title: "missed" },
      { date: "2026-10-01", attended: undefined, title: "unconfirmed" },
    ]);
    const result = await sendDueFeedbackRequests({ now: NOW }, deps);
    expect(result).toMatchObject({ status: "completed", sent: 2, unknown: 0 });
    expect(deps.sendWhatsAppTemplate.mock.calls.map(([m]) => m.variables[2]).sort())
      .toEqual(["seven-day boundary", "thirty-day boundary"]);
    expect(await feedback.countDocuments()).toBe(2);
  });

  it("requires explicit complete HTTPS configuration and never loads data when disabled", async () => {
    for (const env of [
      {}, { ...ENV, FEEDBACK_REQUESTS_ENABLED: "false" },
      { ...ENV, CRON_SECRET: "" }, { ...ENV, TWILIO_TEMPLATE_SOUL_TREATMENT_FEEDBACK: "" },
      { ...ENV, FEEDBACK_PUBLIC_BASE_URL: "http://clinic.example" },
      { ...ENV, FEEDBACK_PUBLIC_BASE_URL: "https://user:pass@clinic.example" },
      { ...ENV, FEEDBACK_PUBLIC_BASE_URL: "https://localhost" },
      { ...ENV, TWILIO_ACCOUNT_SID: "" }, { ...ENV, TWILIO_AUTH_TOKEN: "" },
      { ...ENV, TWILIO_WHATSAPP_FROM: "" },
    ]) {
      const getCollection = vi.fn(() => { throw new Error("Must not load database"); });
      const result = await sendDueFeedbackRequests({ now: NOW }, { ...deps, env, getCollection });
      expect(["disabled", "not_configured"]).toContain(result.status);
      expect(getCollection).not.toHaveBeenCalled();
    }
    expect(deps.sendWhatsAppTemplate).not.toHaveBeenCalled();
  });

  it("dry-run reports eligible counts without tokens, customer data, claims, or messages", async () => {
    await customer([{}]);
    const result = await sendDueFeedbackRequests({ now: NOW, dryRun: true }, deps);
    expect(result).toMatchObject({ eligible: 1, sent: 0, dryRun: true });
    expect(JSON.stringify(result)).not.toMatch(/972|زبون|token|\/feedback\//);
    expect(await feedback.countDocuments()).toBe(0);
    expect(deps.sendWhatsAppTemplate).not.toHaveBeenCalled();
  });

  it("keeps random bearer only in the delivered URL, persists its digest, and never resends", async () => {
    const { appointmentId, token } = await issue();
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const record = await feedback.findOne({ _id: appointmentId });
    expect(record.tokenHash).toBe(createHash("sha256").update(token).digest("hex"));
    expect(record.expiresAt.toISOString()).toBe("2026-11-22T09:00:00.000Z");
    expect(record.dispatch.status).toBe("sent");
    expect(JSON.stringify(record)).not.toContain(token);
    await sendDueFeedbackRequests({ now: NOW }, deps);
    expect(deps.sendWhatsAppTemplate).toHaveBeenCalledTimes(1);
  });

  it("concurrent cron workers claim each appointment once and independent appointments get independent tokens", async () => {
    await customer([{}, { date: "2026-10-14", time: "15:00" }]);
    await Promise.all(Array.from({ length: 6 }, () => sendDueFeedbackRequests({ now: NOW }, deps)));
    expect(deps.sendWhatsAppTemplate).toHaveBeenCalledTimes(2);
    expect(deliveredToken(0)).not.toBe(deliveredToken(1));
    expect(await feedback.countDocuments()).toBe(2);
  });

  it("bounds each run and continues unsent appointments on the next run", async () => {
    await customer(Array.from({ length: 55 }, () => ({})));
    const first = await sendDueFeedbackRequests({ now: NOW }, deps);
    expect(first.sent).toBe(50);
    const next = await sendDueFeedbackRequests({ now: NOW }, deps);
    expect(next.sent).toBe(5);
    expect(deps.sendWhatsAppTemplate).toHaveBeenCalledTimes(55);
  });

  it("skips arbitrarily many older invalid contacts so the valid queue cannot starve", async () => {
    await customer(Array.from({ length: 55 }, () => ({ date: "2026-10-01" })), { phone: "invalid" });
    await customer([{}]);
    expect((await sendDueFeedbackRequests({ now: NOW }, deps)).sent).toBe(1);
    expect(deps.sendWhatsAppTemplate).toHaveBeenCalledTimes(1);
  });

  it("measures seven days in Israel local time across the autumn DST change", async () => {
    await customer([
      { date: "2026-10-18", time: "12:00", title: "due" },
      { date: "2026-10-18", time: "12:01", title: "not yet" },
    ]);
    const result = await sendDueFeedbackRequests({ now: new Date("2026-10-25T10:00:00Z") }, deps);
    expect(result.sent).toBe(1);
    expect(deps.sendWhatsAppTemplate.mock.calls[0][0].variables[2]).toBe("due");
  });

  it("does not send if cancellation happens after claiming and retains the claim", async () => {
    const user = await customer([{}]);
    deps.getCollection = async (name) => name !== "appointmentFeedback" ? db.collection(name) : new Proxy(feedback, {
      get(target, key) {
        if (key === "insertOne") return async (...args) => {
          const inserted = await feedback.insertOne(...args);
          await users.updateOne({ _id: user._id }, { $set: { appointments: [] } });
          return inserted;
        };
        return typeof target[key] === "function" ? target[key].bind(target) : target[key];
      },
    });
    const result = await sendDueFeedbackRequests({ now: NOW }, deps);
    expect(result.sent).toBe(0);
    expect(deps.sendWhatsAppTemplate).not.toHaveBeenCalled();
    expect((await feedback.findOne({})).dispatch.status).toBe("canceled");
  });

  it("retains the durable claim after provider success and a database status-write failure", async () => {
    await customer([{}]);
    deps.getCollection = async (name) => name !== "appointmentFeedback" ? db.collection(name) : new Proxy(feedback, {
      get(target, key) {
        if (key === "updateOne") return async () => { throw new Error("write interrupted"); };
        return typeof target[key] === "function" ? target[key].bind(target) : target[key];
      },
    });
    const result = await sendDueFeedbackRequests({ now: NOW }, deps);
    expect(result.unknown).toBe(1);
    expect((await feedback.findOne({})).dispatch.status).toBe("claimed");
    await sendDueFeedbackRequests({ now: NOW }, deps);
    expect(deps.sendWhatsAppTemplate).toHaveBeenCalledTimes(1);
  });

  it("requests majority acknowledgement for the send claim, result, and immutable response", async () => {
    const writes = [];
    const listener = ({ command }) => {
      if (command.insert === "appointmentFeedback" || command.update === "appointmentFeedback") writes.push(command);
    };
    client.on("commandStarted", listener);
    try {
      const { token } = await issue();
      await submitAppointmentFeedback({ token, text: "durable", now: NOW }, deps);
      expect(writes).toHaveLength(3);
      for (const command of writes) expect(command.writeConcern?.w).toBe("majority");
    } finally {
      client.off("commandStarted", listener);
    }
  });

  it("records an ambiguous provider outcome without retaining or exposing its error and never retries it", async () => {
    await customer([{}]);
    deps.sendWhatsAppTemplate.mockImplementation(async ({ variables }) => {
      throw new Error(`socket disconnected after sending ${variables[4]}`);
    });
    const result = await sendDueFeedbackRequests({ now: NOW }, deps);
    expect(result).toMatchObject({ sent: 0, unknown: 1 });
    const record = await feedback.findOne({});
    expect(record.dispatch.status).toBe("unknown");
    expect(JSON.stringify({ record, result })).not.toMatch(/socket|https|\/feedback\//);
    await sendDueFeedbackRequests({ now: NOW }, deps);
    expect(deps.sendWhatsAppTemplate).toHaveBeenCalledTimes(1);
  });

  it("rechecks attendance immediately before claim/send and excludes malformed contact data", async () => {
    const user = await customer([{}]);
    const realCollection = deps.getCollection;
    deps.getCollection = async (name) => {
      if (name !== "usersData") return realCollection(name);
      return new Proxy(users, {
        get(target, key) {
          if (key === "findOne") return async (...args) => {
            await users.updateOne({ _id: user._id }, { $set: { "appointments.0.attended": false } });
            return users.findOne(...args);
          };
          return typeof target[key] === "function" ? target[key].bind(target) : target[key];
        },
      });
    };
    await sendDueFeedbackRequests({ now: NOW }, deps);
    expect(deps.sendWhatsAppTemplate).not.toHaveBeenCalled();
    expect(await feedback.countDocuments()).toBe(0);
    deps.getCollection = realCollection;
    await customer([{}], { phone: "bad" });
    await sendDueFeedbackRequests({ now: NOW }, deps);
    expect(deps.sendWhatsAppTemplate).not.toHaveBeenCalled();
  });

  it("normalizes provider template text onto one line", async () => {
    await customer([{ title: "العلاج\nالجديد\tالخاص" }], { firstName: "اسم\nأول" });
    await sendDueFeedbackRequests({ now: NOW }, deps);
    const message = deps.sendWhatsAppTemplate.mock.calls[0][0];
    expect(message).toMatchObject({ to: "whatsapp:+972521234567", templateSid: ENV.TWILIO_TEMPLATE_SOUL_TREATMENT_FEEDBACK });
    expect(message.variables[1]).toBe("اسم أول تجريبي");
    expect(message.variables[2]).toBe("العلاج الجديد الخاص");
    expect(message.variables[3]).toBe("2026-10-16");
  });
});

describe("private immutable feedback", () => {
  it("reveals only one appointment and submission state, never profile or submitted text", async () => {
    const { token } = await issue();
    expect(await getFeedbackRequest({ token, now: NOW }, deps)).toEqual({
      appointment: { title: "حجامة", date: "2026-10-16", time: "12:00" }, submitted: false,
    });
    await submitAppointmentFeedback({ token, text: "ممتاز\n<script>plain text</script>", now: NOW }, deps);
    const publicResult = await getFeedbackRequest({ token, now: NOW }, deps);
    expect(publicResult).toEqual({ appointment: { title: "حجامة", date: "2026-10-16", time: "12:00" }, submitted: true });
    expect(JSON.stringify(publicResult)).not.toMatch(/ممتاز|phone|firstName|lastName|userId|972|private note/);
    expect((await feedback.findOne({})).feedback.text).toBe("ممتاز\n<script>plain text</script>");
  });

  it("rejects tampered, malformed, and expired bearer links", async () => {
    const { token } = await issue();
    for (const invalid of ["bad", `${token.slice(0, -1)}${token.endsWith("A") ? "B" : "A"}`, null]) {
      await expect(getFeedbackRequest({ token: invalid, now: NOW }, deps)).rejects.toMatchObject({ status: 404, code: "FEEDBACK_UNAVAILABLE" });
    }
    for (const action of [getFeedbackRequest, submitAppointmentFeedback]) {
      await expect(action({ token, text: "expired", now: new Date("2026-11-22T09:00:00Z") }, deps))
        .rejects.toMatchObject({ status: 404 });
    }
    expect((await feedback.findOne({})).feedback).toBeUndefined();
  });

  it.each(["removed", "attendance", "owner"])("revokes access when appointment is changed: %s", async (change) => {
    const { user, token } = await issue();
    if (change === "removed") await users.updateOne({ _id: user._id }, { $set: { appointments: [] } });
    if (change === "attendance") await users.updateOne({ _id: user._id }, { $set: { "appointments.0.attended": false } });
    if (change === "owner") {
      await users.deleteOne({ _id: user._id });
      await users.insertOne({ ...user, _id: new ObjectId() });
    }
    await expect(getFeedbackRequest({ token, now: NOW }, deps)).rejects.toMatchObject({ status: 404 });
    await expect(submitAppointmentFeedback({ token, now: NOW, text: "revoked" }, deps)).rejects.toMatchObject({ status: 404 });
    expect((await feedback.findOne({})).feedback).toBeUndefined();
  });

  it("accepts 10,000 plain-text characters and rejects empty, non-string, and oversized text", async () => {
    const { token } = await issue();
    for (const text of ["", "  \n  ", null, 2, {}, "أ".repeat(10_001)]) {
      await expect(submitAppointmentFeedback({ token, text, now: NOW }, deps)).rejects.toMatchObject({ status: 400 });
    }
    expect(await submitAppointmentFeedback({ token, text: "أ".repeat(10_000), now: NOW }, deps)).toEqual({ success: true });
    expect((await feedback.findOne({})).feedback.text).toHaveLength(10_000);
  });

  it("concurrent and repeated submissions preserve exactly one immutable response", async () => {
    const { token } = await issue();
    const results = await Promise.allSettled(["first", "second", "third"].map((text) =>
      submitAppointmentFeedback({ token, text, now: NOW }, deps)));
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((r) => r.status === "rejected").every((r) => r.reason.code === "ALREADY_SUBMITTED")).toBe(true);
    const before = (await feedback.findOne({})).feedback;
    await expect(submitAppointmentFeedback({ token, text: "overwrite", now: NOW }, deps)).rejects.toMatchObject({ status: 409 });
    expect((await feedback.findOne({})).feedback).toEqual(before);
  });
});
