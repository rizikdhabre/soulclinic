import { NextResponse } from "next/server";
import { getCustomerAppointments } from "@/lib/customerAppointments";
import { requireCustomerSession } from "@/lib/customerSession";

const CUSTOMER_UNAUTHORIZED_BODY = {
  error: "CUSTOMER_UNAUTHORIZED",
  message: "Customer session is invalid or expired.",
};
const CUSTOMER_APPOINTMENTS_ERROR_BODY = {
  error: "CUSTOMER_APPOINTMENTS_UNAVAILABLE",
  message: "Customer appointments are unavailable.",
};

export async function GET(request) {
  try {
    const session = await requireCustomerSession(request);
    const appointments = await getCustomerAppointments(session.phone);
    return NextResponse.json({ appointments });
  } catch (error) {
    if (
      error?.code === "CUSTOMER_UNAUTHORIZED" &&
      error?.status === 401
    ) {
      return NextResponse.json(CUSTOMER_UNAUTHORIZED_BODY, { status: 401 });
    }

    return NextResponse.json(
      CUSTOMER_APPOINTMENTS_ERROR_BODY,
      { status: 500 },
    );
  }
}
