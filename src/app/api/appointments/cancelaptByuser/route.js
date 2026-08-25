import { NextResponse } from "next/server";
import { cancelCustomerAppointment } from "@/lib/customerAppointments";
import { requireCustomerSession } from "@/lib/customerSession";

const CANONICAL_APPOINTMENT_ID = /^[0-9a-f]{24}$/;

const ERROR_RESPONSES = Object.freeze({
  CUSTOMER_UNAUTHORIZED: {
    status: 401,
    body: {
      error: "CUSTOMER_UNAUTHORIZED",
      message: "Customer session is invalid or expired.",
    },
  },
  INVALID_APPOINTMENT_ID: {
    status: 400,
    body: {
      error: "INVALID_APPOINTMENT_ID",
      message: "Appointment ID is invalid.",
    },
  },
  APPOINTMENT_NOT_FOUND: {
    status: 404,
    body: {
      error: "APPOINTMENT_NOT_FOUND",
      message: "Appointment was not found.",
    },
  },
  CUSTOMER_CANCELLATION_FAILED: {
    status: 500,
    body: {
      error: "CUSTOMER_CANCELLATION_FAILED",
      message: "Appointment cancellation failed.",
    },
  },
});

function errorResponse(code) {
  const response =
    ERROR_RESPONSES[code] ?? ERROR_RESPONSES.CUSTOMER_CANCELLATION_FAILED;
  return NextResponse.json(response.body, { status: response.status });
}

export async function DELETE(req) {
  let session;
  try {
    session = await requireCustomerSession(req);
  } catch (error) {
    if (error?.code === "CUSTOMER_UNAUTHORIZED" && error?.status === 401) {
      return errorResponse("CUSTOMER_UNAUTHORIZED");
    }
    return errorResponse("CUSTOMER_CANCELLATION_FAILED");
  }

  let body;
  try {
    body = await req.json();
  } catch {
    return errorResponse("INVALID_APPOINTMENT_ID");
  }

  const appointmentId = body?.appointmentId;
  if (
    !body ||
    typeof body !== "object" ||
    Array.isArray(body) ||
    typeof appointmentId !== "string" ||
    !CANONICAL_APPOINTMENT_ID.test(appointmentId)
  ) {
    return errorResponse("INVALID_APPOINTMENT_ID");
  }

  try {
    await cancelCustomerAppointment({
      phone: session.phone,
      appointmentId,
    });
    return NextResponse.json({ success: true });
  } catch (error) {
    if (
      ERROR_RESPONSES[error?.code] &&
      ERROR_RESPONSES[error.code].status === error?.status
    ) {
      return errorResponse(error.code);
    }
    return errorResponse("CUSTOMER_CANCELLATION_FAILED");
  }
}
