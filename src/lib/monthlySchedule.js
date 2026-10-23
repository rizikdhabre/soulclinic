import { isTransactionUnsupportedError } from "@/lib/mongoTransactions";
import { buildMonthlySchedulePreview, buildMonthlyScheduleState, MonthlyScheduleError, monthlyScheduleDates, monthlyScheduleHash, normalizeMonthlySchedule, normalizeMonthlyScheduleMonth, selectedMonthlyScheduleDates } from "@/lib/monthlyScheduleRules";

const UUID = /^[a-f\d]{8}-[a-f\d]{4}-[1-8][a-f\d]{3}-[89ab][a-f\d]{3}-[a-f\d]{12}$/i;
const projection = { date: 1, editedTimes: 1, blockedTimes: 1, appointments: 1 };
const unavailable = () => new MonthlyScheduleError("SCHEDULE_STORAGE_UNAVAILABLE", "تعذر حفظ الجدول الآن. أعد محاولة الطلب نفسه.", 503);
const changed = () => new MonthlyScheduleError("SCHEDULE_CHANGED", "تغير الجدول أو الحجوزات. أعد المعاينة قبل الحفظ.", 409);

function timestamp(deps) {
  const now = typeof deps.now === "function" ? deps.now() : deps.now ?? new Date();
  if (!(now instanceof Date) || !Number.isFinite(now.getTime())) throw unavailable();
  return now;
}

async function database(deps, requireClient = false) {
  let { db, client } = deps;
  if (!db || (requireClient && !client)) {
    const production = await import("@/lib/db");
    client ||= await production.getMongoClient();
    db ||= client.db("soul");
  }
  return { db, client };
}

async function currentDocuments(dates, db, session) {
  return db.collection("appointments").find({ date: { $in: dates } }, {
    projection, ...(session ? { session } : { readConcern: { level: "majority" } }),
  }).sort({ date: 1, _id: 1 }).toArray();
}

async function currentPreview(intent, db, now, session) {
  const dates = selectedMonthlyScheduleDates(intent).map(({ date }) => date);
  const documents = await currentDocuments(dates, db, session);
  return buildMonthlySchedulePreview(intent, documents, now);
}

export async function getMonthlyScheduleState(input, deps = {}) {
  const month = normalizeMonthlyScheduleMonth(input?.month);
  try {
    const { db } = await database(deps);
    const documents = await currentDocuments(monthlyScheduleDates(month).map(({ date }) => date), db);
    return buildMonthlyScheduleState(month, documents);
  } catch (error) {
    if (error instanceof MonthlyScheduleError) throw error;
    throw unavailable();
  }
}

export async function previewMonthlySchedule(input, deps = {}) {
  const intent = normalizeMonthlySchedule(input);
  try {
    const { db } = await database(deps);
    return await currentPreview(intent, db, timestamp(deps));
  } catch (error) {
    if (error instanceof MonthlyScheduleError) throw error;
    throw unavailable();
  }
}

function replay(receipt, payloadHash) {
  if (!receipt) return null;
  if (receipt.payloadHash !== payloadHash) throw new MonthlyScheduleError("REQUEST_ID_REUSED", "استُخدم معرف الطلب لعملية مختلفة. أنشئ معاينة جديدة.", 409);
  return receipt.result;
}

function rejectConflicts(preview) {
  if (preview.conflicts.length) throw Object.assign(new MonthlyScheduleError(
    "APPOINTMENT_CONFLICT", "لا يمكن حفظ الجدول لأن التغييرات تتعارض مع مواعيد محجوزة. عدّل الأوقات المحددة وأعد المعاينة.", 409,
  ), { conflicts: preview.conflicts });
}

async function ensureDateIndex(collection) {
  try {
    let indexes;
    try { indexes = await collection.listIndexes().toArray(); } catch (error) {
      if (error.code !== 26) throw error; // A missing collection is safe to create.
      indexes = [];
    }
    const uniqueDate = indexes.some((index) => index.unique === true && !index.sparse && !index.partialFilterExpression
      && Object.keys(index.key).length === 1 && [1, -1].includes(index.key.date));
    if (!uniqueDate) await collection.createIndex({ date: 1 }, { unique: true, name: "unique_appointment_date" });
  } catch {
    throw unavailable();
  }
}

export async function applyMonthlySchedule(input, deps = {}) {
  const intent = normalizeMonthlySchedule(input);
  if (typeof input.requestId !== "string" || !UUID.test(input.requestId)
    || typeof input.previewToken !== "string" || !/^[a-f\d]{64}$/.test(input.previewToken)) {
    throw new MonthlyScheduleError("INVALID_SCHEDULE", "يجب إنشاء معاينة صالحة ومعرف طلب صالح قبل الحفظ.");
  }
  const requestId = input.requestId.toLowerCase();
  const payloadHash = monthlyScheduleHash({ intent, previewToken: input.previewToken });
  let session;
  let db;
  let receipts;
  try {
    const resolved = await database(deps, true);
    db = resolved.db;
    receipts = db.collection("monthlyScheduleApplications");
    const committed = replay(await receipts.findOne({ _id: requestId }, { readConcern: { level: "majority" } }), payloadHash);
    // Replay before checking today's date or current schedules. An old retry
    // must never reapply its arrays over edits made after the original commit.
    if (committed) return committed;

    // Do not use the legacy index helper: it swallows installation failures.
    // The UUID receipt uses Mongo's built-in unique _id index.
    await ensureDateIndex(db.collection("appointments"));
    session = resolved.client.startSession();
    return await session.withTransaction(async () => {
      const existing = replay(await receipts.findOne({ _id: requestId }, { session }), payloadHash);
      if (existing) return existing;
      const now = timestamp(deps);
      const preview = await currentPreview(intent, db, now, session);
      // A newly incompatible booking is more useful than a generic stale token.
      // Check inside the same transaction before changing any day or receipt.
      rejectConflicts(preview);
      if (preview.previewToken !== input.previewToken) throw changed();
      const days = preview.days.filter((day) => day.status === "apply");
      if (!days.length) throw new MonthlyScheduleError("NO_DATES_TO_APPLY", "لا توجد أيام قابلة للتطبيق ضمن الاختيارات الحالية.");

      for (const day of days) {
        // Updating the same day document as booking writers makes races conflict
        // with this transaction. Its retry rechecks the complete preview state.
        // Preserve existing appointments and all unrelated day metadata.
        await db.collection("appointments").updateOne({ date: day.date }, {
          $set: { editedTimes: day.nextTimes, blockedTimes: day.nextBlockedTimes },
          $setOnInsert: { date: day.date, appointments: [] },
        }, { session, upsert: true });
      }
      const result = { success: true, requestId, summary: preview.summary, appliedDates: days.map((day) => day.date) };
      await receipts.insertOne({ _id: requestId, payloadHash, result, createdAt: now }, { session });
      return result;
    }, { readConcern: { level: "snapshot" }, writeConcern: { w: "majority" }, maxCommitTimeMS: 10_000 });
  } catch (error) {
    if (error instanceof MonthlyScheduleError) throw error;
    if (isTransactionUnsupportedError(error)) throw new MonthlyScheduleError("TRANSACTIONS_REQUIRED", "يتطلب حفظ الجدول دعماً للمعاملات في قاعدة البيانات.", 503);
    if (receipts && (error?.code === 11000 || error?.hasErrorLabel?.("UnknownTransactionCommitResult"))) {
      // A competing identical attempt or an uncertain response may already have
      // committed. Only a majority-visible receipt establishes that success.
      try {
        const result = replay(await receipts.findOne({ _id: requestId }, { readConcern: { level: "majority" } }), payloadHash);
        if (result) return result;
        if (error.code === 11000) {
          const preview = await currentPreview(intent, db, timestamp(deps));
          rejectConflicts(preview);
          if (preview.previewToken !== input.previewToken) throw changed();
        }
      } catch (recoveryError) {
        if (recoveryError instanceof MonthlyScheduleError) throw recoveryError;
      }
    }
    throw unavailable();
  } finally {
    await session?.endSession();
  }
}
