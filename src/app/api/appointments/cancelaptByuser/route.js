import { getCollection } from "@/lib/db";
import { NextResponse } from "next/server";
import { sendWhatsAppTemplate } from "@/lib/whatsapp";

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

    const user = await usersCollection.findOne({ phone });

    if (!user) {
      return NextResponse.json({ error: "User not found" }, { status: 404 });
    }

    const firstName = user.firstName || "";
    const lastName = user.lastName || "";

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
      {
        date,
        "appointments.time": time,
      },
      {
        $pull: {
          appointments: { time },
        },
      },
    );

    await sendWhatsAppTemplate({
      to: process.env.TWILIO_WHATSAPP_TO,
      templateSid: process.env.TWILIO_TEMPLATE_CANCEL_CUSTUMER,
      variables: {
        1: firstName,
        2: lastName,
        3: phone,
        4: date,
        5: time,
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
