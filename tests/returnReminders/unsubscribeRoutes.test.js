import { createHash } from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { MongoClient } from "mongodb";
import { MongoMemoryServer } from "mongodb-memory-server-core";
import twilio from "twilio";

const external = vi.hoisted(() => ({ getCollection: vi.fn() }));
vi.mock("@/lib/db", () => ({ getCollection: external.getCollection }));

import { GET, POST } from "@/app/api/reminders/unsubscribe/[token]/route";
import { POST as inbound } from "@/app/api/whatsapp/inbound/route";
import { setReturnReminderPreference } from "@/lib/returnReminderPreferences";

const PHONE = "+972521234567";
const TOKEN = Buffer.alloc(32, 11).toString("base64url");
const AUTH_TOKEN = "isolated-inbound-auth-token";
const URL = "https://clinic.example/api/whatsapp/inbound?configured=1";
const FROM = "whatsapp:+14155238886";
const SID = `SM${"a".repeat(32)}`;
const context = (token = TOKEN) => ({ params: Promise.resolve({ token }) });
const publicRequest = (method = "GET", body) => new Request(`https://clinic.example/api/reminders/unsubscribe/${TOKEN}`, { method, body });
let server, client, db, preferences;

beforeAll(async () => {
  server = await MongoMemoryServer.create({
    instance: { ip: "127.0.0.1", launchTimeout: 120_000 }, spawn: { windowsHide: true },
  });
  const uri = server.getUri();
  if (!uri.startsWith("mongodb://127.0.0.1:")) throw new Error("Expected loopback test MongoDB");
  client = new MongoClient(uri);
  await client.connect();
  db = client.db("return_reminder_unsubscribe_routes_test");
}, 120_000);

afterAll(async () => {
  await client?.close();
  await server?.stop();
});
afterEach(() => vi.unstubAllEnvs());

beforeEach(async () => {
  await db.dropDatabase();
  preferences = db.collection("returnReminderPreferences");
  external.getCollection.mockImplementation(async (name) => db.collection(name));
  vi.stubEnv("TWILIO_AUTH_TOKEN", AUTH_TOKEN);
  vi.stubEnv("TWILIO_INBOUND_WEBHOOK_URL", URL);
  vi.stubEnv("TWILIO_WHATSAPP_FROM", FROM);
});

async function issueLink() {
  await db.collection("returnReminderHistory").insertOne({
    phone: PHONE, tokenHash: createHash("sha256").update(TOKEN).digest("hex"),
    userId: "private-user", appointment: { title: "private-treatment" }, claimedAt: new Date("2010-01-01"),
  });
  await setReturnReminderPreference({ phone: PHONE, enabled: true, source: "admin" });
}

function signedRequest(fields = {}, options = {}) {
  const params = { From: `whatsapp:${PHONE}`, To: FROM, Body: "إيقاف", MessageSid: SID, ...fields };
  const form = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    for (const item of Array.isArray(value) ? value : [value]) form.append(key, item);
  }
  const signature = twilio.getExpectedTwilioSignature(AUTH_TOKEN, options.signatureUrl || URL, params);
  return new Request(options.requestUrl || "http://internal-proxy/api/whatsapp/inbound", {
    method: "POST", body: form,
    headers: {
      "content-type": "application/x-www-form-urlencoded; charset=UTF-8",
      "x-twilio-signature": signature,
      "x-forwarded-host": "untrusted-forwarded.example", ...options.headers,
    },
  });
}

describe("private unsubscribe HTTP boundary", () => {
  it("GET is a read-only status with no personal details, caching, indexing or referrer leakage", async () => {
    await issueLink();
    const before = await preferences.findOne({ _id: PHONE });
    const result = await GET(publicRequest(), context());
    expect(result.status).toBe(200);
    expect(await result.json()).toEqual({ unsubscribed: false });
    expect(result.headers.get("cache-control")).toContain("no-store");
    expect(result.headers.get("referrer-policy")).toBe("no-referrer");
    expect(result.headers.get("x-robots-tag")).toContain("noindex");
    expect(await preferences.findOne({ _id: PHONE })).toEqual(before);
  });

  it("POST disables only the token's phone and remains safe to repeat", async () => {
    await issueLink();
    const otherPhone = "+972531234567";
    await setReturnReminderPreference({ phone: otherPhone, enabled: true, source: "admin" });
    for (let i = 0; i < 2; i++) {
      const result = await POST(publicRequest("POST", JSON.stringify({ phone: otherPhone, enabled: true })), context());
      expect(result.status).toBe(200);
      expect(await result.json()).toEqual({ success: true, unsubscribed: true });
    }
    expect((await preferences.findOne({ _id: PHONE })).enabled).toBe(false);
    expect((await preferences.findOne({ _id: otherPhone })).enabled).toBe(true);
  });

  it("invalid and unknown links have the same stable error without exposing their tokens", async () => {
    for (const token of ["invalid", TOKEN]) {
      const result = await GET(publicRequest(), context(token));
      expect(result.status).toBe(404);
      expect(await result.json()).toEqual({ error: "RETURN_REMINDER_LINK_UNAVAILABLE" });
      expect(result.headers.get("cache-control")).toContain("no-store");
    }
    const result = await POST(publicRequest("POST"), context("invalid"));
    expect(result.status).toBe(404);
    expect(await preferences.countDocuments()).toBe(0);
  });

  it("storage exceptions expose no internals and never report successful unsubscribe", async () => {
    await issueLink();
    external.getCollection.mockRejectedValue(new Error(`private internal database ${TOKEN}`));
    for (const handler of [GET, POST]) {
      const result = await handler(publicRequest(handler === GET ? "GET" : "POST"), context());
      expect(result.status).toBe(500);
      expect(await result.json()).toEqual({ error: "RETURN_REMINDER_UNSUBSCRIBE_FAILED" });
    }
    expect((await preferences.findOne({ _id: PHONE })).enabled).toBe(true);
  });
});

describe("signed WhatsApp inbound opt-out", () => {
  it.each(["إيقاف", "ايقاف", "إِيْقَاف", " إيقاف ", "STOP", "unsubscribe", "UnSuBsCrIbE"])
  ("durably opts out a signed %s message before returning scoped Arabic confirmation", async (body) => {
    const result = await inbound(signedRequest({ Body: body }));
    expect(result.status).toBe(200);
    expect(result.headers.get("content-type")).toContain("xml");
    expect(await result.text()).toContain("تم إيقاف تذكيرات العودة للعيادة");
    expect(await preferences.findOne({ _id: PHONE })).toMatchObject({ enabled: false, source: "whatsapp" });
  });

  it("rejects missing or forged signatures without touching storage", async () => {
    for (const signature of ["", "forged-signature"]) {
      const result = await inbound(signedRequest({}, { headers: { "x-twilio-signature": signature } }));
      expect(result.status).toBe(403);
    }
    expect(external.getCollection).not.toHaveBeenCalled();
    expect(await preferences.countDocuments()).toBe(0);
  });

  it("stops reading an oversized streamed body without trusting Content-Length", async () => {
    let chunksRead = 0;
    let canceled = false;
    const body = new ReadableStream({
      pull(controller) {
        if (chunksRead === 30) return controller.close();
        chunksRead++;
        controller.enqueue(new TextEncoder().encode("x".repeat(40_000)));
      },
      cancel() { canceled = true; },
    });
    const request = new Request("https://clinic.example/api/whatsapp/inbound", {
      method: "POST", body, duplex: "half",
      headers: { "content-type": "application/x-www-form-urlencoded", "x-twilio-signature": "untrusted" },
    });
    const result = await inbound(request);
    expect(result.status).toBe(413);
    expect(canceled).toBe(true);
    expect(chunksRead).toBeLessThan(30);
    expect(external.getCollection).not.toHaveBeenCalled();
  });

  it("fails closed when the exact public URL, auth token or configured recipient is missing", async () => {
    for (const [name, value] of [["TWILIO_INBOUND_WEBHOOK_URL", URL], ["TWILIO_AUTH_TOKEN", AUTH_TOKEN], ["TWILIO_WHATSAPP_FROM", FROM]]) {
      vi.stubEnv(name, "");
      const result = await inbound(signedRequest());
      expect(result.status).toBe(503);
      vi.stubEnv(name, value);
    }
    expect(external.getCollection).not.toHaveBeenCalled();
  });

  it("validates against the configured URL despite proxy headers and rejects signatures for another URL", async () => {
    expect((await inbound(signedRequest())).status).toBe(200);
    await preferences.deleteMany({});
    expect((await inbound(signedRequest({}, { signatureUrl: "https://untrusted-forwarded.example/api/whatsapp/inbound" }))).status).toBe(403);
    expect(await preferences.countDocuments()).toBe(0);
  });

  it("includes extra and repeated URL-encoded parameters in signature validation", async () => {
    expect((await inbound(signedRequest({ FutureField: "one", Extra: ["two", "three"] }))).status).toBe(200);
    await preferences.deleteMany({});
    const signed = signedRequest({ FutureField: "original" });
    const altered = new Request(signed.url, {
      method: "POST", headers: signed.headers,
      body: (await signed.text()).replace("FutureField=original", "FutureField=tampered"),
    });
    expect((await inbound(altered)).status).toBe(403);
    expect(await preferences.countDocuments()).toBe(0);
  });

  it("rejects signed wrong-recipient, non-WhatsApp and ambiguous sender requests", async () => {
    for (const fields of [
      { To: "whatsapp:+14155239999" }, { From: PHONE }, { From: `whatsapp:${PHONE}junk` },
      { From: [`whatsapp:${PHONE}`, "whatsapp:+972531234567"] }, { Body: ["STOP", "hello"] },
    ]) {
      const result = await inbound(signedRequest(fields));
      expect([400, 403]).toContain(result.status);
    }
    expect(external.getCollection).not.toHaveBeenCalled();
    expect(await preferences.countDocuments()).toBe(0);
  });

  it("requires a valid signed message SID for replay protection on opt-outs", async () => {
    for (const MessageSid of ["", "not-a-message-id"]) {
      expect((await inbound(signedRequest({ MessageSid }))).status).toBe(400);
    }
    expect(await preferences.countDocuments()).toBe(0);
  });

  it("replayed opt-outs do not undo subsequent explicit permission or send false confirmation", async () => {
    expect((await inbound(signedRequest())).status).toBe(200);
    expect((await inbound(signedRequest())).status).toBe(200);
    await setReturnReminderPreference({ phone: PHONE, enabled: true, source: "admin" });
    const replay = await inbound(signedRequest());
    expect(replay.status).toBe(200);
    expect(await replay.text()).not.toContain("<Message>");
    expect((await preferences.findOne({ _id: PHONE })).enabled).toBe(true);
  });

  it("keeps ordinary signed messages' static reply and never auto-enables on START", async () => {
    await preferences.insertOne({ _id: PHONE, enabled: false });
    for (const Body of ["مرحبا", "START", "stop please", "يرجى الإيقاف لاحقاً"]) {
      const result = await inbound(signedRequest({ Body }));
      expect(result.status).toBe(200);
      const text = await result.text();
      expect(text).toContain("هذا الرقم مخصص لإرسال الإشعارات الآلية فقط.");
      expect(text).toContain("+972507456258");
    }
    expect((await preferences.findOne({ _id: PHONE })).enabled).toBe(false);
    expect(external.getCollection).not.toHaveBeenCalled();
  });

  it("persists provider OptOutType STOP while avoiding an extra reply, and never treats provider START as consent", async () => {
    const stopped = await inbound(signedRequest({ Body: "custom keyword", OptOutType: "STOP" }));
    expect(stopped.status).toBe(200);
    expect(await stopped.text()).not.toContain("<Message>");
    expect((await preferences.findOne({ _id: PHONE })).enabled).toBe(false);
    const started = await inbound(signedRequest({ Body: "START", OptOutType: "START" }));
    expect(await started.text()).not.toContain("<Message>");
    expect((await preferences.findOne({ _id: PHONE })).enabled).toBe(false);
  });

  it("returns failure without a success reply when opt-out storage fails", async () => {
    external.getCollection.mockRejectedValue(new Error("private database failure"));
    const result = await inbound(signedRequest());
    expect(result.status).toBe(500);
    const text = await result.text();
    expect(text).not.toContain("تم إيقاف");
    expect(text).not.toContain("private database failure");
    expect(await preferences.countDocuments()).toBe(0);
  });
});
