import { createHash } from "node:crypto";
import { normalizeIsraeliPhone } from "@/lib/phone";

const WRITE_CONCERN = { w: "majority", j: true, wtimeoutMS: 10_000 };
const SOURCES = new Set(["admin", "unsubscribe_link", "whatsapp"]);
const POLICY_REVISION = "owner-reconfirmed-2026-10-23";
const OWNER_RECONFIRMED_AT = Date.parse("2026-10-23T15:27:08.000Z");

export function isReturnReminderEnabled(preference) {
  // The owner confirmed renewed permission for existing customers and the
  // default for future customers. This policy does not manufacture consent rows.
  if (preference == null || preference.enabled === true) return true;
  if (preference.enabled !== false || Object.hasOwn(preference, "policyRevision") || !SOURCES.has(preference.source)) return false;

  // Apply the one-time renewal only to identifiable old choices. Missing or
  // malformed audit data must not hide a later opt-out. Every new choice carries
  // a revision, so even an old injected clock cannot undo a new unsubscribe.
  const timestamps = [preference.updatedAt, preference.disabledAt].filter((value) => value !== undefined);
  if (!timestamps.length || timestamps.some((value) => !(value instanceof Date) || !Number.isFinite(value.getTime()))) return false;
  return Math.max(...timestamps.map((value) => value.getTime())) <= OWNER_RECONFIRMED_AT;
}

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
  const preference = await preferences.findOne({ _id: key }, {
    projection: { enabled: 1, source: 1, updatedAt: 1, disabledAt: 1, policyRevision: 1 },
  });
  return { enabled: isReturnReminderEnabled(preference) };
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
      enabled, source, updatedAt: now, policyRevision: POLICY_REVISION,
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
      enabled: false, source: "whatsapp", updatedAt: now, disabledAt: now, adminId: null, policyRevision: POLICY_REVISION,
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
  return { success: true, unsubscribed: !isReturnReminderEnabled(result) };
}
