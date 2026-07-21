import { NextResponse } from "next/server";
import { verifyToken } from "@/lib/jwt";
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

function getAdminPayload(req) {
  const token = req.cookies.get("token")?.value;
  if (!token) return null;

  return verifyToken(token);
}

export async function POST(req) {
  try {
    const adminPayload = getAdminPayload(req);

    if (!adminPayload) {
      return NextResponse.json(
        {
          error: "UNAUTHORIZED",
          message: "Admin login is required.",
        },
        { status: 401 },
      );
    }

    if (adminPayload.role !== "admin") {
      return NextResponse.json(
        {
          error: "FORBIDDEN",
          message: "Admin permissions are required.",
        },
        { status: 403 },
      );
    }

    const body = await req.json();
    const result = await createAppointmentBooking(body, { requireOtp: false });

    console.info("Admin appointment booked without OTP", {
      provider: "admin",
      adminId: adminPayload.id || adminPayload._id || adminPayload.email || null,
    });

    return NextResponse.json(result);
  } catch (error) {
    if (error instanceof TimeSlotUnavailableError || error?.status === 409) {
      return getUnavailableResponse();
    }

    if (error instanceof RequestValidationError || error?.status === 400) {
      return getValidationResponse(error);
    }

    console.error("Admin create appointment error:", error);
    return NextResponse.json(
      {
        error: "ADMIN_BOOKING_FAILED",
        message: "Failed to create appointment.",
      },
      { status: 500 },
    );
  }
}
