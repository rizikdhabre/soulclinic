import { ObjectId } from "mongodb";
import { isValidClinicDate } from "@/lib/clinicTime";
import { normalizeIsraeliPhone } from "@/lib/phone";
import { isValidPainRelief } from "@/lib/feedbackRating";

const array = (value) => Array.isArray(value) ? value : [];
const string = (value) => typeof value === "string" ? value : "";
const key = (value) => value instanceof ObjectId ? value.toHexString()
  : typeof value === "string" && /^[a-f\d]{24}$/iu.test(value) ? value.toLowerCase() : null;
const fullName = (value) => `${string(value?.firstName)} ${string(value?.lastName)}`.trim() || "زبون غير متوفر";
const ownerPhone = (value) => typeof value === "string" ? normalizeIsraeliPhone(value) : null;
const readOptions = (deps, projection) => ({
  projection, maxTimeMS: Number.isSafeInteger(deps.maxTimeMS) && deps.maxTimeMS > 0 ? deps.maxTimeMS : 10_000,
  ...(deps.session ? { session: deps.session } : {}),
});
const getCollections = async (deps) => deps.getCollection || (await import("@/lib/db")).getCollection;
const ids = (values) => [...new Set(values.map(key).filter(Boolean))].map((value) => new ObjectId(value));
const variants = (values) => ids(values).flatMap((value) => [value, value.toHexString()]);
const titleOf = (rows) => {
  const titles = [...new Set(rows.map((row) => string(row.title).trim()).filter(Boolean))];
  // Conflicting historical copies are not a safe source for treatment details.
  return titles.length === 1 ? titles[0] : "علاج غير محدد";
};

export async function loadTomorrowAppointments({ date }, deps = {}) {
  if (!isValidClinicDate(date)) throw new Error("INVALID_REPORT_DATE");
  const getCollection = await getCollections(deps);
  const calendar = await getCollection("appointments");
  const days = await calendar.find({ date }, readOptions(deps, {
    date: 1, "appointments._id": 1, "appointments.firstName": 1, "appointments.lastName": 1,
    "appointments.phone": 1, "appointments.time": 1,
  })).toArray();
  const entries = days.flatMap((day) => array(day.appointments)).filter((entry) => entry && typeof entry === "object");
  if (!entries.length) return [];
  const users = await getCollection("usersData");
  const owners = await users.find({ "appointments._id": { $in: variants(entries.map((entry) => entry._id)) } }, readOptions(deps, {
    phone: 1, "appointments._id": 1, "appointments.date": 1, "appointments.time": 1, "appointments.title": 1,
  })).toArray();
  return entries.map((entry) => {
    const appointmentId = key(entry._id);
    const phone = ownerPhone(entry.phone);
    const matches = phone && appointmentId ? owners.filter((owner) => ownerPhone(owner.phone) === phone)
      .flatMap((owner) => array(owner.appointments))
      .filter((appointment) => appointment && key(appointment._id) === appointmentId && appointment.date === date && appointment.time === entry.time) : [];
    return {
      id: appointmentId ? new ObjectId(appointmentId) : string(entry._id),
      name: fullName(entry), phone: string(entry.phone), title: titleOf(matches), time: string(entry.time),
    };
  }).sort((a, b) => a.time.localeCompare(b.time) || String(a.id).localeCompare(String(b.id)));
}

export async function loadUnreportedFeedback({ from, through }, deps = {}) {
  if (!(from instanceof Date) || !(through instanceof Date) || !Number.isFinite(from.getTime())
    || !Number.isFinite(through.getTime()) || from > through) throw new Error("INVALID_REPORT_RANGE");
  const getCollection = await getCollections(deps);
  const feedback = await getCollection("appointmentFeedback");
  const records = await feedback.find({ "feedback.submittedAt": { $type: "date", $gte: from, $lt: through } }, readOptions(deps, {
    userId: 1, appointmentId: 1, "feedback.submittedAt": 1, "feedback.text": 1, "feedback.painRelief": 1,
  })).sort({ "feedback.submittedAt": 1, _id: 1 }).toArray();
  if (!records.length) return [];
  const claimed = await getCollection("adminDailyReportFeedback");
  const reservations = await claimed.find({ _id: { $in: records.map((record) => record._id) } }, readOptions(deps, { _id: 1 })).toArray();
  const claimedIds = new Set(reservations.map((record) => String(record._id)));
  const pending = records.filter((record) => !claimedIds.has(String(record._id)));
  if (!pending.length) return [];
  const userIds = variants(pending.map((record) => record.userId));
  const appointmentIds = variants(pending.map((record) => record.appointmentId));
  const users = await getCollection("usersData");
  const owners = await users.find({ _id: { $in: userIds } }, readOptions(deps, {
    firstName: 1, lastName: 1, "appointments._id": 1, "appointments.title": 1,
  })).toArray();
  const plans = await getCollection("treatmentPlans");
  const snapshots = await plans.find({ userId: { $in: userIds }, "appointments._id": { $in: appointmentIds } }, readOptions(deps, {
    userId: 1, "appointments._id": 1, "appointments.title": 1,
  })).toArray();
  return pending.map((record) => {
    const userId = key(record.userId);
    const appointmentId = key(record.appointmentId);
    const owner = userId ? owners.find((candidate) => key(candidate._id) === userId) : null;
    const matchesAppointment = (appointment) => appointmentId && appointment && key(appointment._id) === appointmentId;
    const live = array(owner?.appointments).filter(matchesAppointment);
    const saved = userId && appointmentId ? snapshots.filter((plan) => key(plan.userId) === userId)
      .flatMap((plan) => array(plan.appointments)).filter(matchesAppointment) : [];
    return {
      id: record._id, name: fullName(owner), title: titleOf(live.some((appointment) => string(appointment.title).trim()) ? live : saved),
      painRelief: isValidPainRelief(record.feedback.painRelief) ? record.feedback.painRelief : null,
      text: string(record.feedback.text), submittedAt: record.feedback.submittedAt,
    };
  });
}
