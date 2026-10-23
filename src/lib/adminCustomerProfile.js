import { ObjectId } from "mongodb";
import { compareAppointmentToNow, isValidClinicDate, isValidClinicTime } from "@/lib/clinicTime";
import { projectTreatmentPlanComments } from "@/lib/treatmentPlanComments";

const string = (value) => typeof value === "string" ? value : "";
const id = (value) => value instanceof ObjectId ? value.toHexString() : typeof value === "string" && /^[a-f\d]{24}$/i.test(value) ? value.toLowerCase() : null;
const iso = (value) => {
  if (!value) return null;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
};
const array = (value) => Array.isArray(value) ? value : [];
const validAppointment = (appointment) => appointment && id(appointment._id) && isValidClinicDate(appointment.date) && isValidClinicTime(appointment.time);
const byTime = (a, b) => `${a.date} ${a.time}`.localeCompare(`${b.date} ${b.time}`);
const ownedPlans = (plans, userId) => array(plans).filter((plan) => plan && id(plan._id) && id(plan.userId) === userId);
const PLAN_PAGE_SIZE = 3;
const planProjection = { userId: 1, createdAt: 1, "notification.status": 1, appointments: 1, adminComments: 1, commentsVersion: 1 };

function groupById(appointments) {
  const grouped = new Map();
  for (const appointment of appointments) {
    const appointmentId = id(appointment?._id);
    if (!appointmentId) continue;
    if (!grouped.has(appointmentId)) grouped.set(appointmentId, []);
    grouped.get(appointmentId).push(appointment);
  }
  return grouped;
}

function appointmentSnapshot(appointment) {
  return {
    _id: id(appointment._id), date: appointment.date, time: appointment.time,
    title: string(appointment.title), price: Number.isFinite(appointment.price) ? appointment.price : null,
  };
}

function summarizePlan(appointments, invalidCount) {
  const counts = { total: appointments.length + invalidCount, upcoming: 0, attended: 0, notAttended: 0, canceled: 0, unknown: invalidCount };
  for (const appointment of appointments) {
    counts[appointment.status === "not_attended" ? "notAttended" : appointment.status] += 1;
  }
  let status = "unknown";
  if (counts.total && !counts.unknown) {
    if (counts.canceled === counts.total) status = "canceled";
    else if (counts.upcoming) status = counts.attended || counts.notAttended ? "in_progress" : "upcoming";
    else status = counts.notAttended ? "ended" : "completed";
  }
  return { status, counts };
}

export function projectCustomerProfile({ user, feedbackRecords = [], plans = [], calendarDays = [], now = new Date() }) {
  const userId = id(user._id);
  const liveById = groupById(array(user.appointments));
  const customerPlans = ownedPlans(plans, userId);
  const planIds = new Set(customerPlans.flatMap((plan) => array(plan.appointments).map((a) => id(a?._id))).filter(Boolean));
  const calendarById = groupById(array(calendarDays).flatMap((day) => array(day?.appointments)
    .filter((a) => planIds.has(id(a?._id)))
    .map((a) => ({ _id: a._id, date: day.date, time: a.time }))));
  const feedback = new Map(array(feedbackRecords)
    .filter((record) => record && id(record.userId) === userId && id(record.appointmentId) && typeof record.feedback?.text === "string")
    .map((record) => [id(record.appointmentId), { text: record.feedback.text, submittedAt: iso(record.feedback.submittedAt) }]));

  // Legacy booking notes have no appointment ID. Only the current live slot is
  // a supported match; guessing from an old plan slot can attach an orphan note.
  const notesBySlot = new Map();
  for (const note of array(user.notes)) {
    if (!note || !isValidClinicDate(note.date) || !isValidClinicTime(note.time) || typeof note.text !== "string" || !note.text.trim()) continue;
    const key = `${note.date} ${note.time}`;
    if (!notesBySlot.has(key)) notesBySlot.set(key, []);
    notesBySlot.get(key).push(note.text);
  }
  function projectAppointment(appointment, live, forcedStatus) {
    const isPast = compareAppointmentToNow(appointment, now) <= 0;
    // Plan booking never collects notes; an old note at a reused slot belongs
    // to a different standalone booking, not this program session.
    const canMatchBookingNote = live && !planIds.has(id(appointment._id)) && !id(live.treatmentPlanId);
    return {
      ...appointmentSnapshot(appointment), attended: live?.attended === true, isPast,
      status: forcedStatus || (!isPast ? "upcoming" : live?.attended === true ? "attended" : "not_attended"),
      bookingNote: canMatchBookingNote ? (notesBySlot.get(`${live.date} ${live.time}`) || []).join("\n\n") : "",
      feedback: feedback.get(id(appointment._id)) ?? null,
    };
  }
  const appointmentsById = new Map();
  for (const appointment of array(user.appointments).filter(validAppointment)) {
    appointmentsById.set(id(appointment._id), projectAppointment(appointment, appointment));
  }
  const projectedPlans = customerPlans.map((plan) => {
    let invalidCount = 0;
    const seen = new Set();
    const appointments = [];
    for (const snapshot of array(plan.appointments)) {
      const appointmentId = id(snapshot?._id);
      if (!validAppointment(snapshot) || seen.has(appointmentId)) {
        invalidCount += 1;
        continue;
      }
      seen.add(appointmentId);
      const liveRows = liveById.get(appointmentId) || [];
      const calendarRows = calendarById.get(appointmentId) || [];
      const live = liveRows.find(validAppointment);
      const calendar = calendarRows.find(validAppointment);
      let status;
      if (!liveRows.length && !calendarRows.length) {
        status = "canceled";
      } else if (liveRows.length !== 1 || !live || calendarRows.length > 1
        || (calendarRows.length && (!calendar || live.date !== calendar.date || live.time !== calendar.time))
        || (!calendarRows.length && compareAppointmentToNow(live, now) > 0)) {
        // Cancellation/rescheduling writers can update history and the calendar
        // separately. Conflicting copies are uncertain, never proof of cancellation.
        status = "unknown";
      }
      const current = live || (calendar ? { ...snapshot, date: calendar.date, time: calendar.time } : snapshot);
      const appointment = projectAppointment(current, live, status);
      appointments.push(appointment);
      appointmentsById.set(appointmentId, appointment);
    }
    appointments.sort(byTime);
    return {
      _id: id(plan._id), createdAt: iso(plan.createdAt),
      notification: { status: string(plan.notification?.status) || "unknown" },
      ...projectTreatmentPlanComments(plan),
      ...summarizePlan(appointments, invalidCount), appointments,
    };
  }).sort((a, b) => (b.createdAt || "").localeCompare(a.createdAt || "") || b._id.localeCompare(a._id));
  return {
    user: { _id: userId, firstName: string(user.firstName), lastName: string(user.lastName), phone: string(user.phone) },
    appointments: [...appointmentsById.values()].sort((a, b) => byTime(b, a)),
    plans: projectedPlans,
  };
}

function profileError(status, code) {
  return Object.assign(new Error(code), { status, code });
}

async function loadCustomer(userId, db) {
  if (typeof userId !== "string" || !/^[a-f\d]{24}$/i.test(userId)) throw profileError(400, "INVALID_USER_ID");
  const customerId = new ObjectId(userId);
  const collection = db ? (name) => db.collection(name) : (await import("@/lib/db")).getCollection;
  const users = await collection("usersData");
  const user = await users.findOne({ _id: customerId }, { projection: { firstName: 1, lastName: 1, phone: 1, appointments: 1, notes: 1 } });
  if (!user) throw profileError(404, "USER_NOT_FOUND");
  return { user, customerId, collection };
}

function appointmentIdsForPlans(plans) {
  return [...new Set(plans.flatMap((plan) => array(plan.appointments)
    .filter(validAppointment).map((appointment) => id(appointment._id))))];
}

async function loadPlanCalendar(collection, planIds) {
  if (!planIds.length) return [];
  const calendar = await collection("appointments");
  return calendar.find({ "appointments._id": { $in: planIds.map((value) => new ObjectId(value)) } }, {
    projection: { date: 1, "appointments._id": 1, "appointments.time": 1 },
  }).toArray();
}

function planPage(plans, hasMore = plans.length > PLAN_PAGE_SIZE) {
  const page = plans.slice(0, PLAN_PAGE_SIZE);
  return { plans: page, plansPagination: { hasMore, nextCursor: hasMore ? page.at(-1)._id : null } };
}

export async function getAdminCustomerProfile(userId, { db, now = new Date() } = {}) {
  const { user, customerId, collection } = await loadCustomer(userId, db);
  const plansCollection = await collection("treatmentPlans");
  // All snapshots are still needed to recover canceled rows in the complete
  // appointment list. Only three detailed programs are returned to the client.
  const plans = await plansCollection.find({ userId: customerId }, { projection: planProjection }).toArray();
  const planIds = appointmentIdsForPlans(ownedPlans(plans, id(customerId)));
  const appointmentIds = [...new Set([...planIds, ...array(user.appointments).filter(validAppointment)
    .map((appointment) => id(appointment._id))])].map((value) => new ObjectId(value));
  const feedbackCollection = await collection("appointmentFeedback");
  const [feedbackRecords, calendarDays] = await Promise.all([
    feedbackCollection.find({ userId: customerId, appointmentId: { $in: appointmentIds }, "feedback.text": { $type: "string" } }, {
      projection: { userId: 1, appointmentId: 1, feedback: 1 },
    }).toArray(),
    loadPlanCalendar(collection, planIds),
  ]);
  const profile = projectCustomerProfile({ user, feedbackRecords, plans, calendarDays, now });
  return { ...profile, ...planPage(profile.plans) };
}

export async function getAdminCustomerPlans(userId, { cursor = null, db, now = new Date() } = {}) {
  if (cursor !== null && (typeof cursor !== "string" || !id(cursor))) throw profileError(400, "INVALID_CURSOR");
  const { user, customerId, collection } = await loadCustomer(userId, db);
  const plansCollection = await collection("treatmentPlans");
  const filter = { userId: customerId };
  if (cursor !== null) {
    // Resolve the anchor under the same owner; never trust a client-supplied
    // date or offset. Newer inserts cannot shift subsequent pages.
    let anchor = await plansCollection.findOne({ _id: new ObjectId(cursor), userId: customerId }, { projection: { createdAt: 1 } });
    if (!anchor) {
      const deletedRequests = await collection("deletedTreatmentPlanRequests");
      const receipt = await deletedRequests.findOne({ planId: new ObjectId(cursor), userId: customerId }, { projection: { createdAt: 1 } });
      if (receipt) anchor = { _id: new ObjectId(cursor), createdAt: receipt.createdAt };
    }
    if (!anchor || !(anchor.createdAt instanceof Date) || !Number.isFinite(anchor.createdAt.getTime())) throw profileError(400, "INVALID_CURSOR");
    filter.$or = [{ createdAt: { $lt: anchor.createdAt } }, { createdAt: anchor.createdAt, _id: { $lt: anchor._id } }];
  }
  const rows = await plansCollection.find(filter, { projection: planProjection })
    .sort({ createdAt: -1, _id: -1 }).limit(PLAN_PAGE_SIZE + 1).toArray();
  const plans = rows.slice(0, PLAN_PAGE_SIZE);
  const calendarDays = await loadPlanCalendar(collection, appointmentIdsForPlans(plans));
  const projected = projectCustomerProfile({ user, plans, calendarDays, now });
  return planPage(projected.plans, rows.length > PLAN_PAGE_SIZE);
}
