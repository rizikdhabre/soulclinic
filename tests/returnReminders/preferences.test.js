import { createHash } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { MongoClient } from "mongodb";
import { MongoMemoryServer } from "mongodb-memory-server-core";
import {
  getReturnReminderPreference, setReturnReminderPreference,
  getReturnReminderUnsubscribe, unsubscribeReturnReminders, optOutReturnRemindersByPhone,
} from "@/lib/returnReminderPreferences";

vi.mock("@/lib/db", () => ({
  getCollection: () => { throw new Error("Application database access forbidden"); },
}));

const PHONE = "+972521234567";
const TOKEN = Buffer.alloc(32, 7).toString("base64url");
const NOW = new Date("2026-10-23T09:00:00.000Z");
const SID = `SM${"a".repeat(32)}`;
let server, client, db, preferences, history, deps;

beforeAll(async () => {
  server = await MongoMemoryServer.create({
    instance: { ip: "127.0.0.1", launchTimeout: 120_000 }, spawn: { windowsHide: true },
  });
  const uri = server.getUri();
  if (!uri.startsWith("mongodb://127.0.0.1:")) throw new Error("Expected loopback test MongoDB");
  client = new MongoClient(uri, { monitorCommands: true });
  await client.connect();
  db = client.db("return_reminder_preferences_test");
}, 120_000);

afterAll(async () => {
  await client?.close();
  await server?.stop();
});

beforeEach(async () => {
  await db.dropDatabase();
  preferences = db.collection("returnReminderPreferences");
  history = db.collection("returnReminderHistory");
  deps = { getCollection: async (name) => db.collection(name) };
});

async function issueLink() {
  await history.insertOne({
    phone: PHONE, tokenHash: createHash("sha256").update(TOKEN).digest("hex"),
    claimedAt: new Date("2010-01-01"), userId: "private-user", treatment: "private-treatment",
  });
}

describe("shared return reminder permission", () => {
  it("defaults missing and malformed permission to off without creating data", async () => {
    expect(await getReturnReminderPreference({ phone: "052-123-4567" }, deps)).toEqual({ enabled: false });
    expect(await preferences.countDocuments()).toBe(0);
    await preferences.insertOne({ _id: PHONE, enabled: "true" });
    expect(await getReturnReminderPreference({ phone: PHONE }, deps)).toEqual({ enabled: false });
  });

  it("shares explicit consent and opt-out across normalized versions of one phone", async () => {
    expect(await setReturnReminderPreference({ phone: "0521234567", enabled: true, source: "admin", adminId: "admin-test", now: NOW }, deps))
      .toEqual({ enabled: true });
    expect(await getReturnReminderPreference({ phone: "00972521234567" }, deps)).toEqual({ enabled: true });
    expect(await optOutReturnRemindersByPhone({ phone: PHONE, now: NOW }, deps)).toEqual({ success: true, unsubscribed: true });
    expect(await getReturnReminderPreference({ phone: "0521234567" }, deps)).toEqual({ enabled: false });
    expect(await preferences.countDocuments()).toBe(1);
  });

  it("durably upserts an unknown opt-out with a majority write", async () => {
    const writes = [];
    const listener = (event) => {
      if (["update", "findAndModify"].includes(event.commandName)) writes.push(event.command);
    };
    client.on("commandStarted", listener);
    try {
      await optOutReturnRemindersByPhone({ phone: PHONE, now: NOW }, deps);
    } finally {
      client.off("commandStarted", listener);
    }
    expect(writes.length).toBeGreaterThan(0);
    expect(writes.every((command) => command.writeConcern?.w === "majority")).toBe(true);
    expect(writes.every((command) => command.writeConcern?.wtimeout === 10_000)).toBe(true);
    expect(await preferences.findOne({ _id: PHONE })).toMatchObject({ enabled: false, source: "whatsapp", updatedAt: NOW });
  });

  it("rejects invalid phones and non-boolean permission before accessing storage", async () => {
    const isolated = { getCollection: () => { throw new Error("Must not access storage"); } };
    for (const phone of [undefined, "", "+97221234567", "not a phone"]) {
      await expect(getReturnReminderPreference({ phone }, isolated)).rejects.toMatchObject({ code: "INVALID_PHONE" });
    }
    await expect(setReturnReminderPreference({ phone: PHONE, enabled: "true", source: "admin" }, isolated))
      .rejects.toMatchObject({ code: "RETURN_REMINDER_PREFERENCE_INVALID" });
    await expect(setReturnReminderPreference({ phone: PHONE, enabled: true, source: "whatsapp" }, isolated))
      .rejects.toMatchObject({ code: "RETURN_REMINDER_PREFERENCE_INVALID" });
  });

  it("retains a later explicit admin enable when an old inbound message is replayed", async () => {
    await optOutReturnRemindersByPhone({ phone: PHONE, messageSid: SID, now: NOW }, deps);
    await setReturnReminderPreference({ phone: PHONE, enabled: true, source: "admin", now: new Date(NOW.getTime() + 1) }, deps);
    expect(await optOutReturnRemindersByPhone({ phone: PHONE, messageSid: SID, now: new Date(NOW.getTime() + 2) }, deps))
      .toEqual({ success: true, unsubscribed: false });
    expect(await getReturnReminderPreference({ phone: PHONE }, deps)).toEqual({ enabled: true });
    expect((await preferences.findOne({ _id: PHONE })).inboundOptOutMessageSids).toEqual([SID]);
  });

  it("handles concurrent duplicate inbound messages once and accepts a new opt-out after resubscription", async () => {
    await Promise.all(Array.from({ length: 8 }, () => optOutReturnRemindersByPhone({ phone: PHONE, messageSid: SID, now: NOW }, deps)));
    expect((await preferences.findOne({ _id: PHONE })).inboundOptOutMessageSids).toEqual([SID]);
    await setReturnReminderPreference({ phone: PHONE, enabled: true, source: "admin", now: NOW }, deps);
    await optOutReturnRemindersByPhone({ phone: PHONE, messageSid: `SM${"b".repeat(32)}`, now: NOW }, deps);
    expect(await getReturnReminderPreference({ phone: PHONE }, deps)).toEqual({ enabled: false });
    expect((await preferences.findOne({ _id: PHONE })).inboundOptOutMessageSids).toHaveLength(2);
  });
});

describe("private unsubscribe tokens", () => {
  it("resolves an old hashed token without disclosing any linked personal details or writing", async () => {
    await issueLink();
    await setReturnReminderPreference({ phone: PHONE, enabled: true, source: "admin", now: NOW }, deps);
    const before = await preferences.findOne({ _id: PHONE });
    expect(await getReturnReminderUnsubscribe({ token: TOKEN }, deps)).toEqual({ unsubscribed: false });
    expect(await preferences.findOne({ _id: PHONE })).toEqual(before);
    expect(await history.countDocuments()).toBe(1);
  });

  it("GET defaults an unknown preference off without creating it", async () => {
    await issueLink();
    expect(await getReturnReminderUnsubscribe({ token: TOKEN }, deps)).toEqual({ unsubscribed: true });
    expect(await preferences.countDocuments()).toBe(0);
  });

  it("POST is idempotent and an old valid link can opt out again after explicit re-enrollment", async () => {
    await issueLink();
    for (let i = 0; i < 2; i++) {
      expect(await unsubscribeReturnReminders({ token: TOKEN, now: NOW }, deps)).toEqual({ success: true, unsubscribed: true });
    }
    await setReturnReminderPreference({ phone: PHONE, enabled: true, source: "admin", now: NOW }, deps);
    expect(await unsubscribeReturnReminders({ token: TOKEN, now: NOW }, deps)).toEqual({ success: true, unsubscribed: true });
    expect(await preferences.countDocuments()).toBe(1);
    expect(await preferences.findOne({ _id: PHONE })).toMatchObject({ enabled: false, source: "unsubscribe_link" });
    expect(JSON.stringify(await preferences.findOne({ _id: PHONE }))).not.toContain(TOKEN);
    expect(JSON.stringify(await history.findOne({}))).not.toContain(TOKEN);
  });

  it("rejects malformed tokens before database access and gives the same error for unknown valid tokens", async () => {
    const isolated = { getCollection: () => { throw new Error("Must not access storage"); } };
    for (const token of [undefined, "", "short", "!".repeat(43), { $ne: null }]) {
      await expect(getReturnReminderUnsubscribe({ token }, isolated)).rejects.toMatchObject({ code: "RETURN_REMINDER_LINK_UNAVAILABLE" });
    }
    await expect(getReturnReminderUnsubscribe({ token: TOKEN }, deps)).rejects.toMatchObject({ code: "RETURN_REMINDER_LINK_UNAVAILABLE" });
  });

  it("never confirms a disable when storage fails", async () => {
    await issueLink();
    const isolated = { getCollection: async (name) => {
      if (name === "returnReminderHistory") return history;
      throw new Error("Storage unavailable");
    } };
    await expect(unsubscribeReturnReminders({ token: TOKEN }, isolated)).rejects.toThrow("Storage unavailable");
    expect(await preferences.countDocuments()).toBe(0);
  });
});
