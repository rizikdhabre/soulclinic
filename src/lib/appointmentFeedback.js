import { createHash, randomBytes } from "node:crypto";
import { isIP } from "node:net";
import { normalizeIsraeliPhone } from "@/lib/phone";
import { getClinicNowParts, isValidClinicDate, isValidClinicTime } from "@/lib/clinicTime";

const DAY_MS = 24 * 60 * 60 * 1000;
const BATCH_SIZE = 50;
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const TOKEN_LIFETIME_MS = 30 * DAY_MS;
const DURABLE_WRITE = { writeConcern: { w: "majority", wtimeoutMS: 10_000 } };

export class FeedbackError extends Error {
  constructor(code, status) {
    super(code);
    this.name = "FeedbackError";
    this.code = code;
    this.status = status;
  }
}

const unavailable = () => new FeedbackError("FEEDBACK_UNAVAILABLE", 404);
const tokenHash = (token) => createHash("sha256").update(token).digest("hex");

async function collections(deps) {
  // Lazy imports keep disabled jobs independent of database/provider configuration.
  const getCollection = deps.getCollection || (await import("@/lib/db")).getCollection;
  const [users, feedback] = await Promise.all([
    getCollection("usersData"), getCollection("appointmentFeedback"),
  ]);
  return { users, feedback };
}

function wallClockMilliseconds({ date, time }) {
  if (!isValidClinicDate(date) || !isValidClinicTime(time)) return null;
  return Date.parse(`${date}T${time}:00.000Z`);
}

function due(appointment, wallNow) {
  const start = wallClockMilliseconds(appointment);
  if (start === null || appointment.attended !== true) return false;
  const age = wallNow - start;
  return age >= 7 * DAY_MS && age <= 30 * DAY_MS;
}

function publicBaseUrl(value) {
  if (typeof value !== "string" || !value.trim()) return null;
  try {
    const url = new URL(value);
    // Require an explicitly configured public HTTPS origin, never credentials or a loopback/IP target.
    if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash ||
      !url.hostname.includes(".") || url.hostname.endsWith(".localhost") ||
      url.hostname.endsWith(".local") || isIP(url.hostname) || url.hostname.startsWith("[")) return null;
    return url.origin + url.pathname.replace(/\/+$/, "");
  } catch {
    return null;
  }
}

function singleLine(value, maxLength) {
  return typeof value === "string" ? value.replace(/\s+/gu, " ").trim().slice(0, maxLength) : "";
}

async function ownedAppointment(users, record) {
  const user = await users.findOne({
    _id: record.userId,
    appointments: { $elemMatch: { _id: record.appointmentId, attended: true } },
  }, {
    projection: { firstName: 1, lastName: 1, phone: 1, "appointments.$": 1 },
  });
  const appointment = user?.appointments?.[0];
  if (!appointment || !isValidClinicDate(appointment.date) || !isValidClinicTime(appointment.time)) return null;
  return { user, appointment };
}

async function authorizedRequest({ token, now }, deps) {
  if (typeof token !== "string" || !TOKEN_PATTERN.test(token)) throw unavailable();
  const { users, feedback } = await collections(deps);
  const record = await feedback.findOne({ tokenHash: tokenHash(token), expiresAt: { $gt: now } });
  if (!record) throw unavailable();
  const owned = await ownedAppointment(users, record);
  if (!owned || wallClockMilliseconds(owned.appointment) > wallClockMilliseconds(getClinicNowParts(now))) throw unavailable();
  return { record, appointment: owned.appointment, feedback };
}

export async function getFeedbackRequest({ token, now = new Date() }, deps = {}) {
  const { record, appointment } = await authorizedRequest({ token, now }, deps);
  return {
    appointment: { title: typeof appointment.title === "string" ? appointment.title : "", date: appointment.date, time: appointment.time },
    submitted: Boolean(record.feedback?.submittedAt),
  };
}

export async function submitAppointmentFeedback({ token, text, now = new Date() }, deps = {}) {
  if (typeof text !== "string" || !text.trim() || text.length > 10_000) {
    throw new FeedbackError("INVALID_FEEDBACK", 400);
  }
  const { record, feedback } = await authorizedRequest({ token, now }, deps);
  // The conditional write is the submission lock: concurrent requests cannot replace feedback.
  const result = await feedback.updateOne({
    _id: record._id, tokenHash: record.tokenHash, expiresAt: { $gt: now }, feedback: { $exists: false },
  }, { $set: { feedback: { text, submittedAt: now } } }, DURABLE_WRITE);
  if (result.modifiedCount !== 1) throw new FeedbackError("ALREADY_SUBMITTED", 409);
  return { success: true };
}

export async function sendDueFeedbackRequests({ now = new Date(), dryRun = false } = {}, deps = {}) {
  const env = deps.env || process.env;
  const result = { status: "completed", dryRun: Boolean(dryRun), eligible: 0, sent: 0, failed: 0, unknown: 0, skipped: 0 };
  if (env.FEEDBACK_REQUESTS_ENABLED !== "true") return { ...result, status: "disabled" };
  const baseUrl = publicBaseUrl(env.FEEDBACK_PUBLIC_BASE_URL);
  if (!baseUrl || !env.TWILIO_TEMPLATE_SOUL_TREATMENT_FEEDBACK?.trim() || !env.CRON_SECRET?.trim() ||
    !env.TWILIO_ACCOUNT_SID?.trim() || !env.TWILIO_AUTH_TOKEN?.trim() || !env.TWILIO_WHATSAPP_FROM?.trim()) {
    return { ...result, status: "not_configured" };
  }

  const clinicNow = getClinicNowParts(now);
  const wallNow = wallClockMilliseconds(clinicNow);
  const earliest = new Date(wallNow - 30 * DAY_MS).toISOString().slice(0, 10);
  const latest = new Date(wallNow - 7 * DAY_MS).toISOString().slice(0, 10);
  const { users, feedback } = await collections(deps);
  // Initialize configuration before consuming any durable claims.
  const send = dryRun ? null : deps.sendWhatsAppTemplate || (await import("@/lib/whatsapp")).sendWhatsAppTemplate;
  if (!dryRun) {
    await feedback.createIndex({ tokenHash: 1 }, {
      name: "feedback_token_hash", unique: true,
      partialFilterExpression: { tokenHash: { $type: "string" } },
      ...DURABLE_WRITE,
    });
  }
  const candidates = users.aggregate([
    { $match: { appointments: { $elemMatch: { attended: true, date: { $gte: earliest, $lte: latest } } } } },
    { $unwind: "$appointments" },
    { $match: {
      "appointments.attended": true,
      "appointments.date": { $gte: earliest, $lte: latest },
      $and: [
        { $or: [{ "appointments.date": { $gt: earliest } }, { "appointments.date": earliest, "appointments.time": { $gte: clinicNow.time } }] },
        { $or: [{ "appointments.date": { $lt: latest } }, { "appointments.date": latest, "appointments.time": { $lte: clinicNow.time } }] },
      ],
    } },
    { $lookup: { from: "appointmentFeedback", localField: "appointments._id", foreignField: "_id", as: "previousRequests" } },
    { $match: { previousRequests: { $eq: [] } } },
    { $sort: { "appointments.date": 1, "appointments.time": 1, "appointments._id": 1 } },
    { $project: { _id: 1, appointments: 1 } },
  ]).batchSize(BATCH_SIZE);

  let processed = 0;
  for await (const candidate of candidates) {
    if (processed >= BATCH_SIZE) break;
    if (!candidate.appointments?._id || !due(candidate.appointments, wallNow)) continue;
    const identity = { userId: candidate._id, appointmentId: candidate.appointments._id };
    const owned = await ownedAppointment(users, identity);
    if (!owned || !due(owned.appointment, wallNow)) continue;
    const phone = normalizeIsraeliPhone(owned.user.phone);
    if (!phone) continue;
    result.eligible++;
    if (dryRun) { processed++; continue; }

    const token = randomBytes(32).toString("base64url");
    const record = {
      _id: identity.appointmentId, ...identity, createdAt: now,
      tokenHash: tokenHash(token), expiresAt: new Date(now.getTime() + TOKEN_LIFETIME_MS),
      dispatch: { status: "claimed", claimedAt: now },
    };
    try {
      // _id is the appointment ID, so the built-in unique index is a durable send claim.
      await feedback.insertOne(record, DURABLE_WRITE);
    } catch (error) {
      if (error?.code !== 11000) throw error;
      result.skipped++;
      continue;
    }
    processed++;

    // A cancellation/attendance change while claiming must not send a stale request.
    const current = await ownedAppointment(users, identity);
    const currentPhone = current && normalizeIsraeliPhone(current.user.phone);
    if (!current || !currentPhone || !due(current.appointment, wallNow)) {
      await feedback.updateOne({ _id: record._id, "dispatch.status": "claimed" }, {
        $set: { "dispatch.status": "canceled", "dispatch.completedAt": new Date() },
      }, DURABLE_WRITE);
      result.skipped++;
      continue;
    }

    let outcome;
    try {
      const sent = await send({
        to: `whatsapp:${currentPhone}`,
        templateSid: env.TWILIO_TEMPLATE_SOUL_TREATMENT_FEEDBACK,
        variables: {
          1: singleLine(`${current.user.firstName || ""} ${current.user.lastName || ""}`, 80) || "عزيزي الزبون",
          2: singleLine(current.appointment.title, 200) || "العلاج",
          3: current.appointment.date,
          4: `${baseUrl}/feedback/${token}`,
        },
      });
      outcome = typeof sent?.sid === "string" && sent.sid ? { status: "sent", providerSid: sent.sid } : { status: "unknown" };
    } catch (error) {
      // Only explicit provider rejection is known to have failed. No outcome is automatically retried.
      const status = Number(error?.status);
      outcome = { status: status >= 400 && status < 500 && status !== 408 ? "failed" : "unknown" };
    }
    // Keep raw errors, customer details, and the bearer out of both stored dispatch state and cron responses.
    try {
      await feedback.updateOne({ _id: record._id, "dispatch.status": "claimed" }, {
        $set: { dispatch: { ...record.dispatch, ...outcome, completedAt: new Date() } },
      }, DURABLE_WRITE);
      result[outcome.status]++;
    } catch {
      // The durable claim survives a status-write failure, preventing a blind second send.
      result.unknown++;
    }
  }
  return result;
}
