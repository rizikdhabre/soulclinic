import { getCollection, getMongoClient } from "@/lib/db";
import { NextResponse } from "next/server";
import { ObjectId } from "mongodb";
import { sendWhatsAppTemplate } from "@/lib/whatsapp";
import { normalizeIsraeliPhone } from "@/lib/phone";
import {
  TimeSlotUnavailableError,
  getDurationMinutes,
  getSafeNumber,
  isTimeSlotAvailable,
  toMinutes,
  WORK_END,
} from "@/lib/appointmentRules";
import {
  buildAtomicAvailabilityFilter,
  ensureAppointmentsDateIndex,
  ensureDayDocument,
} from "@/lib/appointmentConcurrency";

/* ---------------- HELPER ---------------- */

class RequestValidationError extends Error {
  constructor(message = "Missing fields") {
    super(message);
    this.name = "RequestValidationError";
    this.status = 400;
  }
}

function getUnavailableResponse() {
  return NextResponse.json(
    {
      error: "TIME_SLOT_UNAVAILABLE",
      message: "This time slot was just booked. Please choose another time.",
    },
    { status: 409 },
  );
}

function isTransactionUnsupportedError(error) {
  const message = String(error?.message || "");

  return (
    error?.codeName === "IllegalOperation" ||
    message.includes("Transaction numbers are only allowed") ||
    message.includes("Transaction not supported") ||
    message.includes("Transactions are not supported") ||
    message.includes("This MongoDB deployment does not support")
  );
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
  usersCollection,
  session,
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

  const setOnInsert = {
    phone,
    firstName,
    lastName,
    createdAt: new Date(),
  };

  if (!noteEntry) {
    setOnInsert.notes = [];
  }

  const update = {
    $setOnInsert: setOnInsert,
    $push: {
      appointments: appointmentEntry,
    },
  };

  if (noteEntry) {
    update.$push.notes = noteEntry;
  }

  await usersCollection.updateOne(
    { phone },
    update,
    { upsert: true, ...(session ? { session } : {}) },
  );
}

async function sendAppointmentNotifications({
  phone,
  firstName,
  lastName,
  title,
  date,
  time,
}) {
  const adminFullName = `${firstName || ""} ${lastName || ""}`.trim();

  try {
    await sendAppointmentConfirmationToCustomer({
      phone,
      firstName,
      lastName,
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
    console.error("WhatsApp appointment notify failed:", err);
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

function assertValidRequestedRange(time, duration) {
  const start = toMinutes(time);
  const workEnd = toMinutes(WORK_END);

  if (start === null || workEnd === null) {
    throw new TimeSlotUnavailableError();
  }

  if (start + duration > workEnd) {
    throw new TimeSlotUnavailableError();
  }
}

async function resolveBookingUser({
  usersCollection,
  normalizedPhone,
  firstName,
  lastName,
  session,
}) {
  const existingUser = await usersCollection.findOne(
    { phone: normalizedPhone },
    {
      projection: { firstName: 1, lastName: 1 },
      ...(session ? { session } : {}),
    },
  );

  if (!existingUser && (!firstName || !lastName)) {
    throw new RequestValidationError();
  }

  return {
    existingUser,
    resolvedFirstName: existingUser?.firstName || firstName,
    resolvedLastName: existingUser?.lastName || lastName,
  };
}

function buildAppointmentData({
  appointmentId,
  firstName,
  lastName,
  phone,
  time,
  duration,
  cupsCount,
}) {
  return {
    _id: appointmentId,
    firstName,
    lastName,
    phone,
    time,
    duration,
    reminderSent: false,
    ...(cupsCount ? { cupsCount } : {}),
  };
}

async function createAppointmentWithTransaction({
  client,
  appointmentsCollection,
  usersCollection,
  appointmentId,
  normalizedPhone,
  firstName,
  lastName,
  note,
  date,
  time,
  safeDuration,
  title,
  safePrice,
  cupsCount,
}) {
  const session = client.startSession();
  let notificationData = null;

  try {
    await session.withTransaction(async () => {
      const { resolvedFirstName, resolvedLastName } =
        await resolveBookingUser({
          usersCollection,
          normalizedPhone,
          firstName,
          lastName,
          session,
        });

      const day = await appointmentsCollection.findOne(
        { date },
        {
          projection: { appointments: 1, blockedTimes: 1, editedTimes: 1 },
          session,
        },
      );

      if (!isTimeSlotAvailable({ day, time, duration: safeDuration })) {
        throw new TimeSlotUnavailableError();
      }

      const appointmentData = buildAppointmentData({
        appointmentId,
        firstName: resolvedFirstName,
        lastName: resolvedLastName,
        phone: normalizedPhone,
        time,
        duration: safeDuration,
        cupsCount,
      });

      const updateResult = await appointmentsCollection.updateOne(
        { date },
        {
          $push: {
            appointments: appointmentData,
          },
        },
        { session },
      );

      if (updateResult.matchedCount !== 1) {
        throw new TimeSlotUnavailableError();
      }

      await upsertUserData({
        usersCollection,
        session,
        appointmentId,
        phone: normalizedPhone,
        firstName: resolvedFirstName,
        lastName: resolvedLastName,
        note,
        date,
        time,
        title,
        price: safePrice,
        cupsCount,
      });

      notificationData = {
        phone: normalizedPhone,
        firstName: resolvedFirstName,
        lastName: resolvedLastName,
        title,
        date,
        time,
      };
    });

    return notificationData;
  } finally {
    await session.endSession();
  }
}

async function createAppointmentWithAtomicFallback({
  appointmentsCollection,
  usersCollection,
  appointmentId,
  normalizedPhone,
  firstName,
  lastName,
  note,
  date,
  time,
  safeDuration,
  title,
  safePrice,
  cupsCount,
}) {
  const { resolvedFirstName, resolvedLastName } = await resolveBookingUser({
    usersCollection,
    normalizedPhone,
    firstName,
    lastName,
  });

  const appointmentData = buildAppointmentData({
    appointmentId,
    firstName: resolvedFirstName,
    lastName: resolvedLastName,
    phone: normalizedPhone,
    time,
    duration: safeDuration,
    cupsCount,
  });

  const updateResult = await appointmentsCollection.findOneAndUpdate(
    buildAtomicAvailabilityFilter({
      date,
      time,
      duration: safeDuration,
    }),
    {
      $push: {
        appointments: appointmentData,
      },
    },
    {
      returnDocument: "after",
      projection: { _id: 1 },
    },
  );

  const updatedDay = updateResult?.value ?? updateResult;

  if (!updatedDay) {
    throw new TimeSlotUnavailableError();
  }

  await upsertUserData({
    usersCollection,
    appointmentId,
    phone: normalizedPhone,
    firstName: resolvedFirstName,
    lastName: resolvedLastName,
    note,
    date,
    time,
    title,
    price: safePrice,
    cupsCount,
  });

  return {
    phone: normalizedPhone,
    firstName: resolvedFirstName,
    lastName: resolvedLastName,
    title,
    date,
    time,
  };
}

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
    const safeDuration = getDurationMinutes(duration);
    const safePrice = getSafeNumber(price);

    assertValidRequestedRange(time, safeDuration);

    const appointmentsCollection = await getCollection("appointments");
    const usersCollection = await getCollection("usersData");
    const appointmentId = new ObjectId();

    await ensureAppointmentsDateIndex(appointmentsCollection);
    await ensureDayDocument(appointmentsCollection, date);

    let notificationData = null;

    try {
      const client = await getMongoClient();

      notificationData = await createAppointmentWithTransaction({
        client,
        appointmentsCollection,
        usersCollection,
        appointmentId,
        normalizedPhone,
        firstName,
        lastName,
        note,
        date,
        time,
        safeDuration,
        title,
        safePrice,
        cupsCount,
      });
    } catch (error) {
      if (!isTransactionUnsupportedError(error)) {
        throw error;
      }

      console.warn(
        "MongoDB transactions unavailable; using atomic appointment fallback.",
      );

      notificationData = await createAppointmentWithAtomicFallback({
        appointmentsCollection,
        usersCollection,
        appointmentId,
        normalizedPhone,
        firstName,
        lastName,
        note,
        date,
        time,
        safeDuration,
        title,
        safePrice,
        cupsCount,
      });
    }

    await sendAppointmentNotifications(notificationData);

    return NextResponse.json({ success: true });
  } catch (error) {
    if (error instanceof TimeSlotUnavailableError || error?.status === 409) {
      return getUnavailableResponse();
    }

    if (error instanceof RequestValidationError || error?.status === 400) {
      return NextResponse.json({ error: "Missing fields" }, { status: 400 });
    }

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
