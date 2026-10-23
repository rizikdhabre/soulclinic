import { createHash } from "node:crypto";
import { ObjectId } from "mongodb";
import { isTimeSlotAvailable, rangesOverlap, toMinutes } from "@/lib/appointmentRules";
import { compareAppointmentToNow, isValidClinicDate, isValidClinicTime } from "@/lib/clinicTime";
import { isTransactionUnsupportedError } from "@/lib/mongoTransactions";
import { normalizeIsraeliPhone } from "@/lib/phone";

const MAX_APPOINTMENTS = 10;
const MAX_SCHEDULE_LENGTH = 700;
const MAX_NAME_LENGTH = 80;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const OBJECT_ID = /^[0-9a-f]{24}$/i;

export class TreatmentPlanError extends Error {
  constructor(code, message, status = 400, rowIndex) {
    super(message);
    this.name = "TreatmentPlanError";
    this.code = code;
    this.status = status;
    if (rowIndex !== undefined) this.rowIndex = rowIndex;
  }
}

function error(code, message, status = 400, rowIndex) {
  return new TreatmentPlanError(code, message, status, rowIndex);
}

function oneLine(value) {
  return String(value ?? "").replace(/\s+/gu, " ").trim();
}

function numeric(value) {
  if (typeof value !== "number" && typeof value !== "string") return NaN;
  if (typeof value === "string" && !value.trim()) return NaN;
  return Number(value);
}

function serviceSnapshot(service) {
  if (!service || typeof service.title !== "string" || !oneLine(service.title)) return null;
  const duration = numeric(service.duration);
  const price = numeric(service.price);
  const cupsCount = service.cupsCount == null || service.cupsCount === "" ? null : numeric(service.cupsCount);
  if (!Number.isSafeInteger(duration) || duration <= 0 || duration > 570) return null;
  if (!Number.isFinite(price) || price < 0) return null;
  if (cupsCount !== null && (!Number.isSafeInteger(cupsCount) || cupsCount < 0)) return null;
  return { title: service.title, duration, price, cupsCount };
}

function normalizeRequest(input) {
  if (!input || typeof input.userId !== "string" || !OBJECT_ID.test(input.userId)) {
    throw error("INVALID_USER_ID", "A valid customer ID is required.");
  }
  if (typeof input.requestId !== "string" || !UUID.test(input.requestId)) {
    throw error("INVALID_REQUEST_ID", "A UUID request ID is required.");
  }
  if (!Array.isArray(input.appointments) || input.appointments.length < 1 || input.appointments.length > MAX_APPOINTMENTS) {
    throw error("INVALID_APPOINTMENTS", "A treatment plan must contain between 1 and 10 appointments.");
  }
  const appointments = input.appointments.map((row, rowIndex) => {
    if (!row || typeof row.treatmentId !== "string" || !OBJECT_ID.test(row.treatmentId) ||
      !Number.isSafeInteger(row.serviceIndex) || row.serviceIndex < 0 ||
      !isValidClinicDate(row.date) || !isValidClinicTime(row.time)) {
      throw error("INVALID_APPOINTMENT", "Each row requires a service, date and time.", 400, rowIndex);
    }
    const expectedService = serviceSnapshot(row.expectedService);
    if (!expectedService) {
      throw error("INVALID_EXPECTED_SERVICE", "Refresh the service catalog and select the service again.", 400, rowIndex);
    }
    return { treatmentId: row.treatmentId.toLowerCase(), serviceIndex: row.serviceIndex, expectedService, date: row.date, time: row.time };
  });
  const request = { userId: input.userId.toLowerCase(), requestId: input.requestId.toLowerCase(), appointments };
  const payloadHash = createHash("sha256").update(JSON.stringify({ userId: request.userId, appointments })).digest("hex");
  return { ...request, payloadHash };
}

function assertSameRequest(plan, request) {
  if (plan.payloadHash !== request.payloadHash || String(plan.userId) !== request.userId) {
    throw error("REQUEST_ID_REUSED", "This request ID was already used for a different treatment plan.", 409);
  }
  return plan;
}

function findCommittedPlan(plans, filter) {
  // A locally visible commit may still roll back after a failover. Only a
  // majority-committed receipt can establish success or authorize dispatch.
  return plans.findOne(filter, { readConcern: { level: "majority" } });
}

async function ensureIndexes(db) {
  try {
    await db.collection("treatmentPlans").createIndex({ requestId: 1 }, { unique: true, name: "unique_treatment_plan_request" });
    // The existing booking paths use this index name. Failure must never be ignored.
    await db.collection("appointments").createIndex({ date: 1 }, { unique: true, name: "unique_appointment_date" });
  } catch {
    throw error("BOOKING_INDEX_UNAVAILABLE", "Treatment plans are temporarily unavailable because booking indexes could not be verified.", 503);
  }
}

async function resolveRows(request, treatments, session, now) {
  const rows = [];
  const catalog = new Map();
  for (const [rowIndex, row] of request.appointments.entries()) {
    if (compareAppointmentToNow(row, now) <= 0) {
      throw error("INVALID_APPOINTMENT", "Appointments must be in the future in Israel local time.", 400, rowIndex);
    }
    if (!catalog.has(row.treatmentId)) {
      catalog.set(row.treatmentId, await treatments.findOne({ _id: new ObjectId(row.treatmentId) }, { session, projection: { services: 1 } }));
    }
    const treatment = catalog.get(row.treatmentId);
    const service = Array.isArray(treatment?.services) ? serviceSnapshot(treatment.services[row.serviceIndex]) : null;
    if (!service) {
      throw error("INVALID_SERVICE", "This service is no longer available. Refresh the service catalog.", 409, rowIndex);
    }
    if (JSON.stringify(service) !== JSON.stringify(row.expectedService)) {
      throw error("SERVICE_CHANGED", "The selected service changed. Refresh the service catalog and select it again.", 409, rowIndex);
    }
    const start = toMinutes(row.time);
    if (rows.some((existing) => existing.date === row.date && rangesOverlap(start, start + service.duration, toMinutes(existing.time), toMinutes(existing.time) + existing.duration))) {
      throw error("PLAN_ROWS_OVERLAP", "Appointments in this treatment plan overlap.", 409, rowIndex);
    }
    rows.push({ _id: new ObjectId(), treatmentId: new ObjectId(row.treatmentId), serviceIndex: row.serviceIndex, ...service, date: row.date, time: row.time });
  }
  return rows;
}

async function insertPlan(request, resources) {
  const { db, client, now, templateConfigured } = resources;
  const plans = db.collection("treatmentPlans");
  const days = db.collection("appointments");
  const users = db.collection("usersData");
  const session = client.startSession();
  try {
    return await session.withTransaction(async () => {
      // Rechecking inside the transaction also handles a simultaneous retry.
      const previous = await plans.findOne({ requestId: request.requestId }, { session });
      if (previous) return assertSameRequest(previous, request);

      const user = await users.findOne({ _id: new ObjectId(request.userId) }, { session, projection: { firstName: 1, lastName: 1, phone: 1 } });
      if (!user) throw error("USER_NOT_FOUND", "Customer not found.", 404);
      const phone = normalizeIsraeliPhone(user.phone);
      const customerName = oneLine(`${user.firstName || ""} ${user.lastName || ""}`);
      if (!phone || !customerName || customerName.length > MAX_NAME_LENGTH) {
        throw error("INVALID_CUSTOMER", "The customer needs a valid phone number and a name of at most 80 characters.");
      }
      const rows = await resolveRows(request, db.collection("treatments"), session, now);
      const schedule = rows.map((row) => `${row.date} ${row.time} - ${oneLine(row.title)}`).join(" | ");
      if (schedule.length > MAX_SCHEDULE_LENGTH) {
        throw error("SCHEDULE_TOO_LONG", "The full treatment schedule exceeds the message limit. Use fewer appointments or shorter service names.");
      }
      const plan = {
        _id: new ObjectId(), userId: user._id, requestId: request.requestId,
        payloadHash: request.payloadHash, createdAt: now, customerName, phone, schedule,
        appointments: rows, notification: { status: templateConfigured ? "pending" : "not_configured" },
      };
      await plans.insertOne(plan, { session });

      for (const [rowIndex, row] of rows.entries()) {
        const day = await days.findOne({ date: row.date }, { session });
        if (!isTimeSlotAvailable({ day, time: row.time, duration: row.duration })) {
          throw error("TIME_SLOT_UNAVAILABLE", "This appointment time is no longer available.", 409, rowIndex);
        }
        const dayEntry = {
          _id: row._id, firstName: user.firstName, lastName: user.lastName, phone,
          time: row.time, duration: row.duration, reminderSent: false, treatmentPlanId: plan._id,
          ...(row.cupsCount !== null ? { cupsCount: row.cupsCount } : {}),
        };
        // Reading and writing each day in the same transaction makes concurrent
        // bookings/availability edits conflict and recheck on transaction retry.
        await days.updateOne({ date: row.date }, {
          $setOnInsert: { date: row.date, blockedTimes: [], editedTimes: [] },
          $push: { appointments: dayEntry },
        }, { upsert: true, session });
      }
      const history = rows.map((row) => ({
        _id: row._id, date: row.date, time: row.time, title: row.title, price: row.price,
        attended: false, treatmentPlanId: plan._id,
        ...(row.cupsCount !== null ? { cupsCount: row.cupsCount } : {}),
      }));
      const saved = await users.updateOne({ _id: user._id }, { $push: { appointments: { $each: history } } }, { session });
      if (saved.matchedCount !== 1) throw error("USER_NOT_FOUND", "Customer not found.", 404);
      return plan;
    }, { readConcern: { level: "snapshot" }, writeConcern: { w: "majority" } });
  } finally {
    await session.endSession();
  }
}

async function notifyOnce(plan, { db, env, sendTemplate, now, templateConfigured }) {
  const plans = db.collection("treatmentPlans");
  if (plan.notification.status !== "pending") return plan.notification.status;

  // Persist uncertainty before crossing the provider boundary. If this process
  // dies or the response is lost, replay must never dispatch the message again.
  let claimed;
  try {
    if (!templateConfigured) {
      const unconfigured = await plans.findOneAndUpdate({ _id: plan._id, "notification.status": "pending" }, {
        $set: { "notification.status": "not_configured" },
      }, { returnDocument: "after", writeConcern: { w: "majority" } });
      if (unconfigured) return "not_configured";
      return (await findCommittedPlan(plans, { _id: plan._id }))?.notification?.status || "unknown";
    }
    claimed = await plans.findOneAndUpdate({ _id: plan._id, "notification.status": "pending" }, {
      $set: { "notification.status": "unknown", "notification.claimedAt": now },
    }, { returnDocument: "after", writeConcern: { w: "majority" } });
  } catch {
    return "unknown";
  }
  if (!claimed) {
    try { return (await findCommittedPlan(plans, { _id: plan._id }))?.notification?.status || "unknown"; }
    catch { return "unknown"; }
  }

  let status = "unknown";
  let providerSid;
  try {
    const send = sendTemplate || (await import("@/lib/whatsapp")).sendWhatsAppTemplate;
    const result = await send({
      to: `whatsapp:${plan.phone}`, templateSid: env.TWILIO_TEMPLATE_SOUL_TREATMENT_PLAN,
      variables: { 1: plan.customerName, 2: plan.schedule },
    });
    if (typeof result?.sid === "string" && result.sid) {
      status = "sent";
      providerSid = result.sid;
    }
  } catch (providerError) {
    // A definite provider rejection is different from an ambiguous timeout or 5xx.
    if (providerError?.status >= 400 && providerError.status < 500 && providerError.status !== 408) status = "failed";
  }
  try {
    await plans.updateOne({ _id: plan._id, "notification.status": "unknown" }, {
      $set: { "notification.status": status, "notification.completedAt": now, ...(providerSid ? { "notification.providerSid": providerSid } : {}) },
    }, { writeConcern: { w: "majority" } });
  } catch {
    // Booking is already committed; an unrecorded send outcome must not look like
    // a booking failure or become eligible for an automatic duplicate send.
    return "unknown";
  }
  return status;
}

/** Book a whole plan atomically. Inject db/client/env/sendTemplate/now in tests. */
export async function createTreatmentPlan(input, deps = {}) {
  const request = normalizeRequest(input);
  let client = deps.client;
  let db = deps.db;
  if (!client || !db) {
    const database = await import("@/lib/db");
    client ||= await database.getMongoClient();
    db ||= client.db("soul");
  }
  const env = deps.env ?? process.env;
  const now = typeof deps.now === "function" ? deps.now() : deps.now || new Date();
  const templateConfigured = Boolean(env.TWILIO_TEMPLATE_SOUL_TREATMENT_PLAN &&
    (deps.sendTemplate || (env.TWILIO_ACCOUNT_SID && env.TWILIO_AUTH_TOKEN && env.TWILIO_WHATSAPP_FROM)));
  const resources = { db, client, env, now, templateConfigured, sendTemplate: deps.sendTemplate };
  const plans = db.collection("treatmentPlans");
  let plan = await findCommittedPlan(plans, { requestId: request.requestId });
  if (plan) assertSameRequest(plan, request);
  else {
    await ensureIndexes(db);
    // New-day upserts can encounter a unique-key race before Mongo labels the
    // transaction transient. Retry the whole transaction, never an individual row.
    for (let attempt = 0; attempt < 5; attempt++) {
      try {
        plan = await insertPlan(request, resources);
        break;
      } catch (cause) {
        if (cause instanceof TreatmentPlanError) throw cause;
        if (isTransactionUnsupportedError(cause)) {
          throw error("TRANSACTIONS_REQUIRED", "Treatment plans require a MongoDB replica set or transaction-capable deployment.", 503);
        }
        const recovered = await findCommittedPlan(plans, { requestId: request.requestId }).catch(() => null);
        if (recovered) {
          plan = assertSameRequest(recovered, request);
          break;
        }
        if (cause?.code === 11000 && attempt < 4) continue;
        if (cause?.hasErrorLabel?.("UnknownTransactionCommitResult")) {
          throw error("TREATMENT_PLAN_OUTCOME_UNKNOWN", "The booking outcome is not yet confirmed. Retry this same request ID.", 503);
        }
        throw error("TREATMENT_PLAN_FAILED", "The treatment plan could not be saved. Retry this same request ID.", 500);
      }
    }
  }
  const status = await notifyOnce(plan, resources);
  return { success: true, planId: String(plan._id), appointmentIds: plan.appointments.map((row) => String(row._id)), notification: { status } };
}
