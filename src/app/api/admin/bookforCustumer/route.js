import { NextResponse } from "next/server";
import { withAdminRoute } from "@/lib/adminAuth";
import { TimeSlotUnavailableError } from "@/lib/appointmentRules";
import {
  RequestValidationError,
  createAppointmentBooking,
} from "@/lib/appointmentBooking";

function getUnavailableResponse() {
  return NextResponse.json(
    {
      error: "TIME_SLOT_UNAVAILABLE",
      message: "This time slot was just booked. Please choose another time.",
    },
    { status: 409 },
  );
}

function getValidationResponse(error) {
  if (error?.code === "INVALID_PHONE") {
    return NextResponse.json(
      {
        error: "INVALID_PHONE",
        message: "Invalid phone number.",
      },
      { status: 400 },
    );
  }

  return NextResponse.json(
    {
      error: error?.code || "MISSING_FIELDS",
      message: error?.message || "Missing fields.",
    },
    { status: 400 },
  );
}

async function createAdminAppointment(req) {
  try {
    const body = await req.json();
    const result = await createAppointmentBooking(body, { requireOtp: false });

    return NextResponse.json(result);
  } catch (error) {
    if (error instanceof TimeSlotUnavailableError || error?.status === 409) {
      return getUnavailableResponse();
    }

    if (error instanceof RequestValidationError) {
      return getValidationResponse(error);
    }

    return NextResponse.json(
      {
        error: "ADMIN_BOOKING_FAILED",
        message: "Failed to create appointment.",
      },
      { status: 500 },
    );
  }
}

export const POST = withAdminRoute(createAdminAppointment);
