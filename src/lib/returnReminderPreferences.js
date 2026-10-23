import { createHash } from "node:crypto";
import { normalizeIsraeliPhone } from "@/lib/phone";

const WRITE_CONCERN = { w: "majority", j: true, wtimeoutMS: 10_000 };
const SOURCES = new Set(["admin", "unsubscribe_link", "whatsapp"]);

function invalid(code) {
  return Object.assign(new Error(code), { code });
}

function normalizedPhone(phone) {
  const normalized = typeof phone === "string" ? normalizeIsraeliPhone(phone) : null;
  if (!normalized) throw invalid("INVALID_PHONE");
  return normalized;
}

function validDate(now) {
  if (!(now instanceof Date) || !Number.isFinite(now.getTime())) {
    throw invalid("RETURN_REMINDER_PREFERENCE_INVALID");
  }
  return now;
}

async function collection(name, deps) {
  const getCollection = deps.getCollection || (await import("@/lib/db")).getCollection;
  return getCollection(name);
}

export async function getReturnReminderPreference({ phone }, deps = {}) {
  const key = normalizedPhone(phone);
  const preferences = await collection("returnReminderPreferences", deps);
  const preference = await preferences.findOne({ _id: key }, { projection: { enabled: 1 } });
  return { enabled: preference?.enabled === true };
}

export async function setReturnReminderPreference({ phone, enabled, source, now = new Date(), adminId }, deps = {}) {
  const key = normalizedPhone(phone);
  if (typeof enabled !== "boolean" || !SOURCES.has(source) || (enabled && source !== "admin")) {
    throw invalid("RETURN_REMINDER_PREFERENCE_INVALID");
  }
  validDate(now);
  const preferences = await collection("returnReminderPreferences", deps);
  await preferences.updateOne({ _id: key }, {
    $set: {
      enabled, source, updatedAt: now,
      [enabled ? "enabledAt" : "disabledAt"]: now,
      adminId: source === "admin" && adminId != null ? String(adminId) : null,
    },
    $setOnInsert: { createdAt: now },
  }, { upsert: true, writeConcern: WRITE_CONCERN });
  return { enabled };
}

async function phoneForToken(token, deps) {
  if (typeof token !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(token)) {
    throw invalid("RETURN_REMINDER_LINK_UNAVAILABLE");
  }
  const history = await collection("returnReminderHistory", deps);
  const record = await history.findOne({ tokenHash: createHash("sha256").update(token).digest("hex") }, {
    projection: { phone: 1 },
  });
  // Links deliberately have no expiration; old messages remain a usable opt-out path.
  const phone = typeof record?.phone === "string" ? normalizeIsraeliPhone(record.phone) : null;
  if (!phone) throw invalid("RETURN_REMINDER_LINK_UNAVAILABLE");
  return phone;
}

export async function getReturnReminderUnsubscribe({ token }, deps = {}) {
  const phone = await phoneForToken(token, deps);
  const { enabled } = await getReturnReminderPreference({ phone }, deps);
  return { unsubscribed: !enabled };
}

export async function unsubscribeReturnReminders({ token, now = new Date() }, deps = {}) {
  const phone = await phoneForToken(token, deps);
  await setReturnReminderPreference({ phone, enabled: false, source: "unsubscribe_link", now }, deps);
  return { success: true, unsubscribed: true };
}

export async function optOutReturnRemindersByPhone({ phone, now = new Date(), messageSid }, deps = {}) {
  const key = normalizedPhone(phone);
  validDate(now);
  if (messageSid === undefined) {
    await setReturnReminderPreference({ phone: key, enabled: false, source: "whatsapp", now }, deps);
    return { success: true, unsubscribed: true };
  }
  if (typeof messageSid !== "string" || !/^SM[0-9a-f]{32}$/i.test(messageSid)) {
    throw invalid("RETURN_REMINDER_PREFERENCE_INVALID");
  }
  const preferences = await collection("returnReminderPreferences", deps);
  // Store receipt + preference in one atomic document update. A retried webhook
  // must not undo a later explicit admin enable, even after a process restart.
  const seen = { $ifNull: ["$inboundOptOutMessageSids", []] };
  const update = [{ $replaceWith: { $cond: [
    { $in: [messageSid, seen] },
    "$$ROOT",
    { $mergeObjects: ["$$ROOT", {
      enabled: false, source: "whatsapp", updatedAt: now, disabledAt: now, adminId: null,
      createdAt: { $ifNull: ["$createdAt", now] },
      inboundOptOutMessageSids: { $concatArrays: [seen, [messageSid]] },
    }] },
  ] } }];
  const options = { upsert: true, returnDocument: "after", writeConcern: WRITE_CONCERN };
  let result;
  try {
    result = await preferences.findOneAndUpdate({ _id: key }, update, options);
  } catch (error) {
    // An initial concurrent upsert can lose the unique _id insertion race.
    if (error?.code !== 11000) throw error;
    result = await preferences.findOneAndUpdate({ _id: key }, update, options);
  }
  if (!result) throw invalid("RETURN_REMINDER_PREFERENCE_FAILED");
  return { success: true, unsubscribed: result.enabled !== true };
}
