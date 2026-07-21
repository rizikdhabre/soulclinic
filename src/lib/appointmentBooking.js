import { ObjectId } from "mongodb";
import { getCollection, getMongoClient } from "@/lib/db";
import { normalizeIsraeliPhone } from "@/lib/phone";
import { sendWhatsAppTemplate } from "@/lib/whatsapp";
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
import {
  consumeOtpVerificationGrant,
  releaseOtpVerificationGrant,
} from "@/lib/otpSecurity";

export class RequestValidationError extends Error {
  constructor(message = "Missing fields", code = "MISSING_FIELDS") {
    super(message);
    this.name = "RequestValidationError";
    this.code = code;
    this.status = 400;
  }
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

async function consumeOtpIfRequired({
  requireOtp,
  normalizedPhone,
  verificationToken,
  appointmentId,
  session,
}) {
  if (!requireOtp) return false;

  await consumeOtpVerificationGrant({
    phone: normalizedPhone,
    verificationToken,
    appointmentId,
    ...(session ? { session } : {}),
  });

  return true;
}

async function releaseOtpIfNeeded({
  requireOtp,
  grantConsumed,
  appointmentSaved,
  normalizedPhone,
  verificationToken,
  appointmentId,
}) {
  if (!requireOtp || !grantConsumed || appointmentSaved) return;

  await releaseOtpVerificationGrant({
    phone: normalizedPhone,
    verificationToken,
    appointmentId,
  });
}

async function createAppointmentWithTransaction({
  client,
  appointmentsCollection,
  usersCollection,
  appointmentId,
  normalizedPhone,
  verificationToken,
  requireOtp,
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
      await consumeOtpIfRequired({
        requireOtp,
        normalizedPhone,
        verificationToken,
        appointmentId,
        session,
      });

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
  verificationToken,
  requireOtp,
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
  let grantConsumed = false;
  let appointmentSaved = false;

  try {
    grantConsumed = await consumeOtpIfRequired({
      requireOtp,
      normalizedPhone,
      verificationToken,
      appointmentId,
    });

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

    appointmentSaved = true;

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
  } catch (error) {
    await releaseOtpIfNeeded({
      requireOtp,
      grantConsumed,
      appointmentSaved,
      normalizedPhone,
      verificationToken,
      appointmentId,
    });

    throw error;
  }
}

export async function createAppointmentBooking(
  {
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
    verificationToken,
  },
  { requireOtp = true } = {},
) {
  if (!phone || !date || !time) {
    throw new RequestValidationError();
  }

  const normalizedPhone = normalizeIsraeliPhone(phone);

  if (!normalizedPhone) {
    throw new RequestValidationError("Invalid phone number.", "INVALID_PHONE");
  }

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
      verificationToken,
      requireOtp,
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
      verificationToken,
      requireOtp,
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

  return { success: true };
}
