import { getCollection, getMongoClient } from "@/lib/db";
import { NextResponse } from "next/server";
import { ObjectId } from "mongodb";
import {
  TimeSlotUnavailableError,
  WORK_END,
  getDurationMinutes,
  isTimeSlotAvailable,
  toMinutes,
} from "@/lib/appointmentRules";
import {
  buildAtomicAvailabilityFilter,
  ensureAppointmentsDateIndex,
} from "@/lib/appointmentConcurrency";

/* ---------------- UPDATE APPOINTMENT TIME ---------------- */

class AppointmentNotFoundError extends Error {
  constructor() {
    super("Appointment not found");
    this.name = "AppointmentNotFoundError";
    this.status = 404;
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

function findAppointment(day, appointmentId) {
  return day?.appointments?.find(
    (appointment) => String(appointment?._id) === String(appointmentId),
  );
}

async function loadDayForAppointment({
  appointmentsCollection,
  date,
  appointmentId,
  session,
}) {
  const day = await appointmentsCollection.findOne(
    { date, "appointments._id": appointmentId },
    {
      projection: { appointments: 1, blockedTimes: 1, editedTimes: 1 },
      ...(session ? { session } : {}),
    },
  );

  if (!day) {
    throw new AppointmentNotFoundError();
  }

  return day;
}

async function updateTimeWithTransaction({
  client,
  appointmentsCollection,
  usersCollection,
  appointmentId,
  date,
  newTime,
}) {
  const session = client.startSession();
  let updated = { appointments: 0, usersData: 0 };

  try {
    await session.withTransaction(async () => {
      const day = await loadDayForAppointment({
        appointmentsCollection,
        date,
        appointmentId,
        session,
      });

      const appointment = findAppointment(day, appointmentId);
      if (!appointment) {
        throw new AppointmentNotFoundError();
      }

      const safeDuration = getDurationMinutes(appointment.duration);
      assertValidRequestedRange(newTime, safeDuration);

      if (
        !isTimeSlotAvailable({
          day,
          time: newTime,
          duration: safeDuration,
          ignoreAppointmentId: appointmentId,
        })
      ) {
        throw new TimeSlotUnavailableError();
      }

      const updateAppointmentsResult = await appointmentsCollection.updateOne(
        {
          date,
          "appointments._id": appointmentId,
        },
        {
          $set: {
            "appointments.$.time": newTime,
          },
        },
        { session },
      );

      if (updateAppointmentsResult.matchedCount !== 1) {
        throw new AppointmentNotFoundError();
      }

      const updateUsersResult = await usersCollection.updateOne(
        {
          "appointments._id": appointmentId,
        },
        {
          $set: {
            "appointments.$.time": newTime,
          },
        },
        { session },
      );

      updated = {
        appointments: updateAppointmentsResult.modifiedCount,
        usersData: updateUsersResult.modifiedCount,
      };
    });

    return updated;
  } finally {
    await session.endSession();
  }
}

async function updateTimeWithAtomicFallback({
  appointmentsCollection,
  usersCollection,
  appointmentId,
  date,
  newTime,
}) {
  const day = await loadDayForAppointment({
    appointmentsCollection,
    date,
    appointmentId,
  });

  const appointment = findAppointment(day, appointmentId);
  if (!appointment) {
    throw new AppointmentNotFoundError();
  }

  const safeDuration = getDurationMinutes(appointment.duration);
  assertValidRequestedRange(newTime, safeDuration);

  const updateAppointmentsResult = await appointmentsCollection.findOneAndUpdate(
    {
      ...buildAtomicAvailabilityFilter({
        date,
        time: newTime,
        duration: safeDuration,
        ignoreAppointmentId: appointmentId,
      }),
      "appointments._id": appointmentId,
    },
    {
      $set: {
        "appointments.$.time": newTime,
      },
    },
    {
      returnDocument: "after",
      projection: { _id: 1 },
    },
  );

  const updatedDay = updateAppointmentsResult?.value ?? updateAppointmentsResult;

  if (!updatedDay) {
    throw new TimeSlotUnavailableError();
  }

  const updateUsersResult = await usersCollection.updateOne(
    {
      "appointments._id": appointmentId,
    },
    {
      $set: {
        "appointments.$.time": newTime,
      },
    },
  );

  return {
    appointments: 1,
    usersData: updateUsersResult.modifiedCount,
  };
}

export async function POST(req) {
  try {
    const { appointmentId, date, newTime } = await req.json();

    if (!appointmentId || !date || !newTime) {
      return NextResponse.json(
        { error: "appointmentId, date and newTime are required" },
        { status: 400 },
      );
    }

    if (!ObjectId.isValid(appointmentId)) {
      return NextResponse.json(
        { error: "Invalid appointmentId" },
        { status: 400 },
      );
    }

    const apptObjectId = new ObjectId(appointmentId);
    const appointmentsCollection = await getCollection("appointments");
    const usersCollection = await getCollection("usersData");

    await ensureAppointmentsDateIndex(appointmentsCollection);

    let updated;

    try {
      const client = await getMongoClient();

      updated = await updateTimeWithTransaction({
        client,
        appointmentsCollection,
        usersCollection,
        appointmentId: apptObjectId,
        date,
        newTime,
      });
    } catch (error) {
      if (!isTransactionUnsupportedError(error)) {
        throw error;
      }

      console.warn(
        "MongoDB transactions unavailable; using atomic update-time fallback.",
      );

      updated = await updateTimeWithAtomicFallback({
        appointmentsCollection,
        usersCollection,
        appointmentId: apptObjectId,
        date,
        newTime,
      });
    }

    return NextResponse.json({
      success: true,
      updated,
    });
  } catch (error) {
    if (error instanceof TimeSlotUnavailableError || error?.status === 409) {
      return getUnavailableResponse();
    }

    if (error instanceof AppointmentNotFoundError || error?.status === 404) {
      return NextResponse.json(
        { error: "Appointment not found" },
        { status: 404 },
      );
    }

    console.error("Update appointment time error:", error);
    return NextResponse.json(
      { error: "Failed to update appointment time" },
      { status: 500 },
    );
  }
}
