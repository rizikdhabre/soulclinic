import { ObjectId } from "mongodb";
import { compareAppointmentToNow, isValidClinicDate, isValidClinicTime } from "@/lib/clinicTime";

const string = (value) => typeof value === "string" ? value : "";
const id = (value) => value instanceof ObjectId ? value.toHexString() : typeof value === "string" && /^[a-f\d]{24}$/i.test(value) ? value.toLowerCase() : null;
const iso = (value) => {
  if (!value) return null;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
};
const array = (value) => Array.isArray(value) ? value : [];
const validAppointment = (appointment) => appointment && id(appointment._id) && isValidClinicDate(appointment.date) && isValidClinicTime(appointment.time);

function appointmentSnapshot(appointment) {
  return {
    _id: id(appointment._id), date: appointment.date, time: appointment.time,
    title: string(appointment.title), price: Number.isFinite(appointment.price) ? appointment.price : null,
  };
}

export function projectCustomerProfile({ user, feedbackRecords = [], plans = [], now = new Date() }) {
  const userId = id(user._id);
  const feedback = new Map(array(feedbackRecords)
    .filter((record) => record && id(record.userId) === userId && id(record.appointmentId) && typeof record.feedback?.text === "string")
    .map((record) => [id(record.appointmentId), { text: record.feedback.text, submittedAt: iso(record.feedback.submittedAt) }]));
  return {
    user: { _id: userId, firstName: string(user.firstName), lastName: string(user.lastName), phone: string(user.phone) },
    appointments: array(user.appointments).filter(validAppointment).map((appointment) => ({
      ...appointmentSnapshot(appointment), attended: appointment.attended === true,
      feedback: feedback.get(id(appointment._id)) ?? null,
      isPast: compareAppointmentToNow(appointment, now) <= 0,
    })).sort((a, b) => `${b.date} ${b.time}`.localeCompare(`${a.date} ${a.time}`)),
    plans: array(plans).filter((plan) => plan && id(plan._id) && id(plan.userId) === userId).map((plan) => ({
      _id: id(plan._id), createdAt: iso(plan.createdAt),
      notification: { status: string(plan.notification?.status) || "unknown" },
      appointments: array(plan.appointments).filter(validAppointment).map(appointmentSnapshot),
    })).sort((a, b) => (b.createdAt || "").localeCompare(a.createdAt || "")),
  };
}

function profileError(status, code) {
  return Object.assign(new Error(code), { status, code });
}

export async function getAdminCustomerProfile(userId, { db, now = new Date() } = {}) {
  if (typeof userId !== "string" || !/^[a-f\d]{24}$/i.test(userId)) throw profileError(400, "INVALID_USER_ID");
  const customerId = new ObjectId(userId);
  const collection = db ? (name) => db.collection(name) : (await import("@/lib/db")).getCollection;
  const users = await collection("usersData");
  const user = await users.findOne({ _id: customerId }, { projection: { firstName: 1, lastName: 1, phone: 1, appointments: 1 } });
  if (!user) throw profileError(404, "USER_NOT_FOUND");
  const appointmentIds = array(user.appointments).filter(validAppointment).map((appointment) => new ObjectId(id(appointment._id)));
  const feedbackCollection = await collection("appointmentFeedback");
  const plansCollection = await collection("treatmentPlans");
  const [feedbackRecords, plans] = await Promise.all([
    feedbackCollection.find({ userId: customerId, appointmentId: { $in: appointmentIds }, "feedback.text": { $type: "string" } }, {
      projection: { userId: 1, appointmentId: 1, feedback: 1 },
    }).toArray(),
    plansCollection.find({ userId: customerId }, { projection: { userId: 1, createdAt: 1, "notification.status": 1, appointments: 1 } }).toArray(),
  ]);
  return projectCustomerProfile({ user, feedbackRecords, plans, now });
}
