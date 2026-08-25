import { getCollection } from "@/lib/db";
import { NextResponse } from "next/server";
import { sendWhatsAppTemplate } from "@/lib/whatsapp";
import { normalizeIsraeliPhone } from "@/lib/phone";
import { AdminAuthError, requireAdmin, withAdminRoute } from "@/lib/adminAuth";
import { toPublicAvailability } from "@/lib/appointmentViews";
import { TimeSlotUnavailableError } from "@/lib/appointmentRules";
import { OtpVerificationGrantError } from "@/lib/otp/bookingGrant";
import {
  RequestValidationError,
  createAppointmentBooking,
} from "@/lib/appointmentBooking";

/* ---------------- HELPER ---------------- */

function getUnavailableResponse() {
  return NextResponse.json(
    {
      error: "TIME_SLOT_UNAVAILABLE",
      message: "This time slot was just booked. Please choose another time.",
    },
    { status: 409 },
  );
}

function getInvalidPhoneResponse() {
  return NextResponse.json(
    {
      error: "INVALID_PHONE",
      message: "Invalid phone number.",
    },
    { status: 400 },
  );
}

function getOtpVerificationErrorResponse(error) {
  const messages = {
    OTP_VERIFICATION_REQUIRED: "OTP verification is required.",
    OTP_VERIFICATION_INVALID: "OTP verification is invalid.",
    OTP_VERIFICATION_EXPIRED: "OTP verification has expired.",
    OTP_VERIFICATION_ALREADY_USED: "OTP verification was already used.",
  };
  const statuses = {
    OTP_VERIFICATION_ALREADY_USED: 409,
  };

  return NextResponse.json(
    {
      error: error.code || "OTP_VERIFICATION_INVALID",
      message:
        messages[error.code] ||
        "OTP verification is missing, invalid, expired, or already used.",
    },
    { status: statuses[error.code] || error.status || 401 },
  );
}

function getAdminAuthorizationResponse(error) {
  return NextResponse.json(
    { error: error.code, message: error.message },
    { status: error.status },
  );
}

function getEmptyAvailability() {
  return { appointments: [], blockedTimes: [], editedTimes: [] };
}

/* ---------------- GET ---------------- */

export async function GET(req) {
  try {
    const { searchParams } = new URL(req.url);
    const date = searchParams.get("date");
    const isAdmin = searchParams.get("admin") === "true";

    if (isAdmin) requireAdmin(req);

    if (!date) {
      return NextResponse.json(getEmptyAvailability());
    }

    const appointmentsCollection = await getCollection("appointments");

    const day = await appointmentsCollection.findOne({ date }, {
      projection: isAdmin
        ? {
            _id: 0,
            blockedTimes: 1,
            editedTimes: 1,
            "appointments._id": 1,
            "appointments.time": 1,
            "appointments.duration": 1,
            "appointments.firstName": 1,
            "appointments.lastName": 1,
            "appointments.phone": 1,
          }
        : {
            _id: 0,
            blockedTimes: 1,
            editedTimes: 1,
            "appointments.time": 1,
            "appointments.duration": 1,
          },
    });

    if (!day) {
      return NextResponse.json(getEmptyAvailability());
    }
    if (!isAdmin) {
      return NextResponse.json(toPublicAvailability(day));
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
    if (error instanceof AdminAuthError) {
      return getAdminAuthorizationResponse(error);
    }

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

    return NextResponse.json(
      await createAppointmentBooking(body, { requireOtp: true }),
    );
  } catch (error) {
    if (error instanceof OtpVerificationGrantError) {
      return getOtpVerificationErrorResponse(error);
    }

    if (error instanceof TimeSlotUnavailableError || error?.status === 409) {
      return getUnavailableResponse();
    }

    if (error instanceof RequestValidationError || error?.status === 400) {
      if (error?.code === "INVALID_PHONE") {
        return getInvalidPhoneResponse();
      }

      return NextResponse.json({ error: "Missing fields" }, { status: 400 });
    }

    console.error("Appointment booking failed.");
    return NextResponse.json(
      { error: "Failed to create appointment" },
      { status: 500 },
    );
  }
}

async function deleteAppointment(req) {
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
    return NextResponse.json(
      { error: "Failed to cancel appointment" },
      { status: 500 },
    );
  }
}

export const DELETE = withAdminRoute(deleteAppointment);
