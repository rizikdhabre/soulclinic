import { getCollection } from "@/lib/db";
import { NextResponse } from "next/server";
import { ObjectId } from "mongodb";
import { sendWhatsAppTemplate } from "@/lib/whatsapp";
import { normalizeIsraeliPhone } from "@/lib/phone";

/* ---------------- HELPER ---------------- */

const SLOT_MINUTES = 30;
const WORK_START = "10:00";
const WORK_END = "19:30";

function buildSlots() {
  const slots = [];

  for (let h = 10; h < 20; h++) {
    for (let m = 0; m < 60; m += SLOT_MINUTES) {
      const time = `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
      if (time <= WORK_END) slots.push(time);
    }
  }

  return slots;
}

const DEFAULT_SLOTS = buildSlots();

function toMinutes(time) {
  const [h, m] = String(time || "")
    .split(":")
    .map(Number);

  if (!Number.isFinite(h) || !Number.isFinite(m)) return null;
  return h * 60 + m;
}

function getDurationMinutes(duration) {
  const n = Number(duration);
  return Number.isFinite(n) && n > 0 ? n : SLOT_MINUTES;
}

function rangesOverlap(startA, endA, startB, endB) {
  return startA < endB && endA > startB;
}

function getScheduleTimes(editedTimes) {
  const workStart = toMinutes(WORK_START);
  const workEnd = toMinutes(WORK_END);
  const sourceTimes =
    Array.isArray(editedTimes) && editedTimes.length > 0
      ? editedTimes
      : DEFAULT_SLOTS;

  return sourceTimes
    .filter((time) => {
      const minutes = toMinutes(time);
      return minutes !== null && minutes >= workStart && minutes <= workEnd;
    })
    .sort((a, b) => toMinutes(a) - toMinutes(b));
}

function isTimeSlotAvailable({ day, time, duration }) {
  const sourceTimes = getScheduleTimes(day?.editedTimes);
  const blockedTimes = Array.isArray(day?.blockedTimes) ? day.blockedTimes : [];
  const appointments = Array.isArray(day?.appointments) ? day.appointments : [];
  const start = toMinutes(time);
  const workEnd = toMinutes(WORK_END);

  if (start === null) return false;

  const end = start + duration;

  if (!sourceTimes.includes(time)) return false;
  if (end > workEnd) return false;
  if (blockedTimes.includes(time)) return false;

  const conflictsWithAppointment = appointments.some((apt) => {
    const aptStart = toMinutes(apt.time);
    if (aptStart === null) return false;

    const aptDuration = getDurationMinutes(apt.duration);
    const aptEnd = aptStart + aptDuration;

    return rangesOverlap(start, end, aptStart, aptEnd);
  });

  if (conflictsWithAppointment) return false;

  return true;
}

export async function sendAppointmentConfirmationToCustomer({
  phone,
  firstName,
  lastName,
  title,
  date,
  time,
}) {
  const fullName = `${firstName || ""} ${lastName || ""}`.trim();
  const toWhatsApp = phone.startsWith("whatsapp:")
    ? phone
    : phone.startsWith("+")
      ? `whatsapp:${phone}`
      : `whatsapp:+${phone}`;
  return sendWhatsAppTemplate({
    to: toWhatsApp,
    templateSid: process.env.TWILIO_TEMPLATE_NEW_APPOINTMENT_CUSTUMER,
    variables: {
      1: fullName || "عزيزي الزبون",
      2: title,
      3: date,
      4: time,
    },
  });
}
async function upsertUserData({
  appointmentId,
  phone,
  firstName,
  lastName,
  note,
  date,
  time,
  title,
  price,
  cupsCount,
}) {
  const usersCollection = await getCollection("usersData");
  const appointmentEntry = {
    _id: appointmentId,
    date,
    time,
    title,
    price,
    attended: false,
    ...(cupsCount ? { cupsCount } : {}),
  };
  const noteEntry = note
    ? {
        text: note,
        date,
        time,
      }
    : null;

  const existingUser = await usersCollection.findOne(
    { phone },
    { projection: { firstName: 1, lastName: 1 } },
  );
  const adminFirstName = existingUser?.firstName || firstName;
  const adminLastName = existingUser?.lastName || lastName;
  const adminFullName = `${adminFirstName || ""} ${adminLastName || ""}`.trim();

  if (!existingUser) {
    await usersCollection.insertOne({
      phone,
      firstName,
      lastName,
      appointments: [appointmentEntry],
      notes: noteEntry ? [noteEntry] : [],
      createdAt: new Date(),
    });
  } else {
    const update = {
      $push: {
        appointments: appointmentEntry,
      },
    };

    if (noteEntry) {
      update.$push.notes = noteEntry;
    }

    await usersCollection.updateOne({ phone }, update);
  }

  try {
    await sendAppointmentConfirmationToCustomer({
      phone,
      firstName: adminFirstName,
      lastName: adminLastName,
      title,
      date,
      time,
    });

    await sendWhatsAppTemplate({
      to: process.env.TWILIO_WHATSAPP_TO,
      templateSid: process.env.TWILIO_TEMPLATE_NEW_APPOINTMENT_ADMIN,
      variables: {
        1: "صقر",
        2: title,
        3: adminFullName,
        4: date,
        5: time,
      },
    });
  } catch (err) {
    console.error("WhatsApp admin notify failed:", err);
  }
}

/* ---------------- GET ---------------- */

export async function GET(req) {
  try {
    const { searchParams } = new URL(req.url);
    const date = searchParams.get("date");
    const isAdmin = searchParams.get("admin") === "true";

    if (!date) {
      return NextResponse.json(
        isAdmin ? { appointments: [], blockedTimes: [], editedTimes: [] } : [],
      );
    }

    const appointmentsCollection = await getCollection("appointments");

    const day = await appointmentsCollection.findOne(
      { date },
      {
        projection: {
          _id: 0,
          blockedTimes: 1,
          editedTimes: 1,
          "appointments._id": 1,
          "appointments.time": 1,
          "appointments.duration": 1,
          "appointments.firstName": 1,
          "appointments.lastName": 1,
          "appointments.phone": 1,
        },
      },
    );

    if (!day) {
      return NextResponse.json(
        isAdmin ? { appointments: [], blockedTimes: [], editedTimes: [] } : [],
      );
    }
    if (!isAdmin) {
      return NextResponse.json({
        appointments: day.appointments || [],
        blockedTimes: day.blockedTimes || [],
        editedTimes: day.editedTimes || [],
      });
    }

    const usersCollection = await getCollection("usersData");

    const appointments = Array.isArray(day.appointments)
      ? day.appointments
      : [];

    const normalizedAppointments = appointments.map((a) => ({
      ...a,
      phone: normalizeIsraeliPhone(a.phone),
    }));

    const phones = [
      ...new Set(normalizedAppointments.map((a) => a.phone).filter(Boolean)),
    ];

    const users = await usersCollection
      .find(
        { phone: { $in: phones } },
        { projection: { phone: 1, appointments: 1 } },
      )
      .toArray();

    const titleMap = new Map();

    for (const user of users) {
      const userPhone = normalizeIsraeliPhone(user.phone);
      for (const apt of user.appointments || []) {
        if (!apt?.date || !apt?.time) continue;
        const key = `${userPhone}_${apt.date}_${apt.time}`;
        titleMap.set(key, apt.title || null);
      }
    }

    const enrichedAppointments = normalizedAppointments.map((apt) => ({
      ...apt,
      title: titleMap.get(`${apt.phone}_${date}_${apt.time}`) || null,
    }));

    return NextResponse.json({
      appointments: enrichedAppointments,
      blockedTimes: day.blockedTimes || [],
      editedTimes: day.editedTimes || [],
    });
  } catch (error) {
    console.error("Fetch appointments error:", error);
    return NextResponse.json(
      { error: "Failed to fetch appointments" },
      { status: 500 },
    );
  }
}
/* ---------------- POST ---------------- */

export async function POST(req) {
  try {
    const body = await req.json();

    const {
      firstName,
      lastName,
      phone,
      note,
      date,
      time,
      duration,
      title,
      price,
      cupsCount,
    } = body;

    if (!phone || !date || !time) {
      return NextResponse.json({ error: "Missing fields" }, { status: 400 });
    }

    const normalizedPhone = normalizeIsraeliPhone(phone) || phone;

    const usersCollection = await getCollection("usersData");
    const existingUser = await usersCollection.findOne(
      { phone: normalizedPhone },
      { projection: { firstName: 1, lastName: 1 } },
    );

    if (!existingUser && (!firstName || !lastName)) {
      return NextResponse.json(
        { error: "Missing fields" },
        { status: 400 },
      );
    }

    const resolvedFirstName = existingUser?.firstName || firstName;
    const resolvedLastName = existingUser?.lastName || lastName;
    const safeDuration = getDurationMinutes(duration);

    const appointmentsCollection = await getCollection("appointments");
    const day = await appointmentsCollection.findOne(
      { date },
      { projection: { appointments: 1, blockedTimes: 1, editedTimes: 1 } },
    );

    if (!isTimeSlotAvailable({ day, time, duration: safeDuration })) {
      return NextResponse.json(
        { error: "Time slot is not available" },
        { status: 409 },
      );
    }

    const appointmentId = new ObjectId();
    const appointmentData = {
      _id: appointmentId,
      firstName: resolvedFirstName,
      lastName: resolvedLastName,
      phone: normalizedPhone,
      time,
      duration: safeDuration,
      reminderSent: false,
      ...(cupsCount ? { cupsCount } : {}),
    };

    await appointmentsCollection.findOneAndUpdate(
      { date },
      {
        $push: {
          appointments: appointmentData,
        },
      },
      {
        upsert: true,
      },
    );
    await upsertUserData({
      appointmentId,
      phone: normalizedPhone,
      firstName,
      lastName,
      note,
      date,
      time,
      title,
      price,
      cupsCount,
    });
    return NextResponse.json({ success: true });
  } catch (error) {
    console.error("Create appointment error:", error);
    return NextResponse.json(
      { error: "Failed to create appointment" },
      { status: 500 },
    );
  }
}

export async function DELETE(req) {
  try {
    const { phone, date, time } = await req.json();

    if (!phone || !date || !time) {
      return NextResponse.json(
        { error: "Missing required fields" },
        { status: 400 },
      );
    }

    const usersCollection = await getCollection("usersData");

    const user = await usersCollection.findOne(
      { phone },
      { projection: { firstName: 1, lastName: 1 } },
    );

    if (!user) {
      return NextResponse.json({ error: "User not found" }, { status: 404 });
    }

    const firstName = user.firstName || "";
    const lastName = user.lastName || "";
    const fullName = `${firstName} ${lastName}`.trim();

    await usersCollection.updateOne(
      { phone },
      {
        $pull: {
          appointments: { date, time },
          notes: { date, time },
        },
      },
    );

    const appointmentsCollection = await getCollection("appointments");

    await appointmentsCollection.updateOne(
      { date, "appointments.time": time },
      { $pull: { appointments: { time } } },
    );
    const toWhatsApp = phone.startsWith("whatsapp:")
      ? phone
      : phone.startsWith("+")
        ? `whatsapp:${phone}`
        : `whatsapp:+${phone}`;

    await sendWhatsAppTemplate({
      to: toWhatsApp,
      templateSid: process.env.TWILIO_TEMPLATE_CANCEL_REALADMIN,
      variables: {
        1: fullName,
        2: date,
        3: time,
      },
    });

    return NextResponse.json({ success: true });
  } catch (error) {
    console.error("Cancel appointment error:", error);
    return NextResponse.json(
      { error: "Failed to cancel appointment" },
      { status: 500 },
    );
  }
}
