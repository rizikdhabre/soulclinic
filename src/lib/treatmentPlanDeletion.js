import { ObjectId } from "mongodb";
import { isValidClinicDate, isValidClinicTime } from "@/lib/clinicTime";
import { isTransactionUnsupportedError } from "@/lib/mongoTransactions";

const identifier = (value) => value instanceof ObjectId ? value.toHexString() : typeof value === "string" && /^[a-f\d]{24}$/i.test(value) ? value.toLowerCase() : null;
const failure = (status, code) => Object.assign(new Error(code), { status, code });
const deleted = () => ({ success: true, deleted: true });

/** Permanently remove a canceled program's content; never cancel appointments here. */
export async function deleteCanceledTreatmentPlan({ userId, planId }, deps = {}) {
  if (typeof userId !== "string" || !identifier(userId)) throw failure(400, "INVALID_USER_ID");
  if (typeof planId !== "string" || !identifier(planId)) throw failure(400, "INVALID_PLAN_ID");
  let { db, client } = deps;
  if (!db || !client) {
    const database = await import("@/lib/db");
    client ||= await database.getMongoClient();
    db ||= client.db("soul");
  }
  const now = deps.now || new Date();
  const owner = new ObjectId(userId), program = new ObjectId(planId);
  const plans = db.collection("treatmentPlans");
  const receipts = db.collection("deletedTreatmentPlanRequests");
  const receiptFilter = { userId: owner, planId: program };
  const session = client.startSession();
  try {
    return await session.withTransaction(async () => {
      const plan = await plans.findOne({ _id: program, userId: owner }, { session });
      if (!plan) {
        if (await receipts.findOne(receiptFilter, { session, projection: { _id: 1 } })) return deleted();
        throw failure(404, "PLAN_NOT_FOUND");
      }
      const appointments = plan.appointments;
      if (!Array.isArray(appointments) || !appointments.length || appointments.some((a) => !a || !identifier(a._id) || !isValidClinicDate(a.date) || !isValidClinicTime(a.time))
        || new Set(appointments.map((a) => identifier(a._id))).size !== appointments.length
        || typeof plan.requestId !== "string" || !/^[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}$/i.test(plan.requestId)
        || !(plan.createdAt instanceof Date) || !Number.isFinite(plan.createdAt.getTime())) {
        throw failure(409, "PLAN_NOT_FULLY_CANCELED");
      }
      const appointmentIds = appointments.map((a) => new ObjectId(identifier(a._id)));
      const identifiers = [...appointmentIds, ...appointmentIds.map(String)];
      const activeFilter = { $or: [
        { "appointments._id": { $in: identifiers } },
        { "appointments.treatmentPlanId": { $in: [program, String(program)] } },
      ] };
      // Check both representations and any inconsistent owner, not just the
      // displayed status. A reused date/time with a different ID is unrelated.
      const history = await db.collection("usersData").findOne(activeFilter, { session, projection: { _id: 1 } });
      const calendar = await db.collection("appointments").findOne(activeFilter, { session, projection: { _id: 1 } });
      if (history || calendar) throw failure(409, "PLAN_NOT_FULLY_CANCELED");

      // Keep only request/owner/program IDs and receipt timestamps, never names,
      // phones, schedules, appointments, feedback, hashes or provider data.
      // This prevents an old POST retry from recreating the deleted bookings.
      await receipts.insertOne({ _id: plan.requestId, ...receiptFilter, createdAt: plan.createdAt, deletedAt: now }, { session });
      await db.collection("appointmentFeedback").deleteMany({ userId: owner, appointmentId: { $in: appointmentIds } }, { session });
      const result = await plans.deleteOne({ _id: program, userId: owner }, { session });
      if (result.deletedCount !== 1) throw failure(409, "PLAN_NOT_FULLY_CANCELED");
      return deleted();
    }, { readConcern: { level: "snapshot" }, writeConcern: { w: "majority" } });
  } catch (error) {
    if (isTransactionUnsupportedError(error)) throw failure(503, "TRANSACTIONS_REQUIRED");
    // A competing delete or an uncertain commit may already have completed.
    if (error?.code === 11000 || error?.hasErrorLabel?.("UnknownTransactionCommitResult")) {
      if (await receipts.findOne(receiptFilter, { readConcern: { level: "majority" }, projection: { _id: 1 } })) return deleted();
    }
    throw error;
  } finally {
    await session.endSession();
  }
}
