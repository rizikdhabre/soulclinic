import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { MongoClient, ObjectId } from "mongodb";
import { MongoMemoryServer } from "mongodb-memory-server-core";
import twilio from "twilio";

const external = vi.hoisted(() => ({ getCollection: vi.fn() }));
vi.mock("@/lib/db", () => ({ getCollection: external.getCollection }));
vi.mock("@/lib/whatsapp", () => ({
  sendWhatsAppTemplate: () => { throw new Error("Real provider access forbidden"); },
}));

import { sendDueReturnReminders } from "@/lib/returnReminders";
import { getReturnReminderUnsubscribe } from "@/lib/returnReminderPreferences";
import { GET, POST } from "@/app/api/reminders/unsubscribe/[token]/route";
import { POST as inbound } from "@/app/api/whatsapp/inbound/route";

const PHONE = "+972521234567";
const NOW = new Date("2026-10-23T09:00:00.000Z");
const NEXT_MONTH = new Date("2026-11-22T09:00:00.000Z");
const ENV = {
  RETURN_REMINDERS_ENABLED: "true",
  TWILIO_TEMPLATE_SOUL_RETURN: "HXreturn-workflow-test",
  RETURN_REMINDERS_PUBLIC_BASE_URL: "https://clinic.example",
  CRON_SECRET: "isolated-workflow-secret",
  TWILIO_ACCOUNT_SID: `AC${"a".repeat(32)}`,
  TWILIO_AUTH_TOKEN: "isolated-workflow-auth-token",
  TWILIO_WHATSAPP_FROM: "whatsapp:+14155238886",
  TWILIO_INBOUND_WEBHOOK_URL: "https://clinic.example/api/whatsapp/inbound",
};
let server, client, db, deps, clockNow;

beforeAll(async () => {
  server = await MongoMemoryServer.create({
    instance: { ip: "127.0.0.1", launchTimeout: 120_000 }, spawn: { windowsHide: true },
  });
  const uri = server.getUri();
  if (!uri.startsWith("mongodb://127.0.0.1:")) throw new Error("Expected loopback test MongoDB");
  client = new MongoClient(uri, { monitorCommands: true });
  await client.connect();
  db = client.db("return_reminder_workflow_test");
}, 120_000);

afterAll(async () => {
  await client?.close();
  await server?.stop();
});
afterEach(() => vi.unstubAllEnvs());

beforeEach(async () => {
  await db.dropDatabase();
  clockNow = NOW;
  external.getCollection.mockImplementation(async (name) => db.collection(name));
  deps = {
    env: { ...ENV }, getCollection: external.getCollection, clock: { now: () => clockNow },
    sendWhatsAppTemplate: vi.fn(async () => ({ sid: `SM${"b".repeat(32)}` })),
  };
  for (const name of ["TWILIO_AUTH_TOKEN", "TWILIO_WHATSAPP_FROM", "TWILIO_INBOUND_WEBHOOK_URL"]) {
    vi.stubEnv(name, ENV[name]);
  }
  await db.collection("usersData").insertOne({
    _id: new ObjectId(), firstName: "زبون", lastName: "تجريبي", phone: "052-123-4567",
    appointments: [{ _id: new ObjectId(), date: "2026-07-23", time: "12:00", attended: true }],
  });
});

async function sendFirstReminder() {
  expect(await sendDueReturnReminders({ now: NOW }, deps)).toMatchObject({ sent: 1, failed: 0, unknown: 0 });
  expect(deps.sendWhatsAppTemplate).toHaveBeenCalledTimes(1);
  expect(await db.collection("returnReminderPreferences").countDocuments()).toBe(0);
  const message = deps.sendWhatsAppTemplate.mock.calls[0][0];
  expect(message).toMatchObject({
    to: `whatsapp:${PHONE}`, templateSid: ENV.TWILIO_TEMPLATE_SOUL_RETURN,
    variables: { 1: "زبون تجريبي", 2: "2026-07-23", 3: "https://clinic.example/dashboard" },
  });
  expect(Object.keys(message.variables)).toHaveLength(4);
  expect(message.variables[4]).toMatch(/^https:\/\/clinic\.example\/reminders\/unsubscribe\/[A-Za-z0-9_-]{43}$/);
  const token = new URL(message.variables[4]).pathname.split("/").pop();
  expect((await db.collection("returnReminderState").findOne({ _id: PHONE })).nextAttemptAt).toEqual(NEXT_MONTH);
  return {
    token, context: { params: Promise.resolve({ token }) },
    apiUrl: `https://clinic.example/api/reminders/unsubscribe/${token}`,
  };
}

async function verifyNoNextReminder() {
  clockNow = NEXT_MONTH;
  expect(await sendDueReturnReminders({ now: NEXT_MONTH }, deps)).toMatchObject({ sent: 0, failed: 0, unknown: 0 });
  expect(deps.sendWhatsAppTemplate).toHaveBeenCalledTimes(1);
  expect(await db.collection("returnReminderHistory").countDocuments()).toBe(1);
  expect((await db.collection("returnReminderState").findOne({ _id: PHONE })).nextAttemptAt).toEqual(NEXT_MONTH);
}

describe("generated return reminders through real opt-out handlers", () => {
  it("opens the generated link without writes, then POST disables the next eligible monthly reminder", async () => {
    const { token, context, apiUrl } = await sendFirstReminder();
    const writes = [];
    const listener = (event) => {
      if (["insert", "update", "findAndModify", "delete", "createIndexes"].includes(event.commandName)) writes.push(event.commandName);
    };
    client.on("commandStarted", listener);
    let viewed;
    try {
      viewed = await GET(new Request(apiUrl), context);
    } finally {
      client.off("commandStarted", listener);
    }
    expect(viewed.status).toBe(200);
    expect(await viewed.json()).toEqual({ unsubscribed: false });
    expect(writes).toEqual([]);

    const stopped = await POST(new Request(apiUrl, { method: "POST" }), context);
    expect(stopped.status).toBe(200);
    expect(await stopped.json()).toEqual({ success: true, unsubscribed: true });
    expect(await getReturnReminderUnsubscribe({ token }, deps)).toEqual({ unsubscribed: true });
    expect(await db.collection("returnReminderPreferences").findOne({ _id: PHONE }))
      .toMatchObject({ enabled: false, source: "unsubscribe_link" });
    await verifyNoNextReminder();
  });

  it("a signed Arabic opt-out after a generated reminder disables its link status and the next monthly reminder", async () => {
    const { token } = await sendFirstReminder();
    const params = {
      From: `whatsapp:${PHONE}`, To: ENV.TWILIO_WHATSAPP_FROM,
      Body: "إيقاف", MessageSid: `SM${"c".repeat(32)}`,
    };
    const signature = twilio.getExpectedTwilioSignature(ENV.TWILIO_AUTH_TOKEN, ENV.TWILIO_INBOUND_WEBHOOK_URL, params);
    const stopped = await inbound(new Request("http://internal-proxy/api/whatsapp/inbound", {
      method: "POST", body: new URLSearchParams(params),
      headers: { "content-type": "application/x-www-form-urlencoded", "x-twilio-signature": signature },
    }));
    expect(stopped.status).toBe(200);
    expect(await stopped.text()).toContain("تم إيقاف تذكيرات العودة للعيادة");
    expect(await db.collection("returnReminderPreferences").findOne({ _id: PHONE }))
      .toMatchObject({ enabled: false, source: "whatsapp" });
    expect(await getReturnReminderUnsubscribe({ token }, deps)).toEqual({ unsubscribed: true });
    await verifyNoNextReminder();
  });
});
