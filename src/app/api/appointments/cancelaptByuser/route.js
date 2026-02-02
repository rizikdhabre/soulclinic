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

    const userDoc = await usersCollection.findOne(
      {
        phone,
        "appointments.date": date,
        "appointments.time": time,
      },
      {
        projection: {
          firstName: 1,
          lastName: 1,
          phone: 1,
          "appointments.$": 1,
        },
      },
    );
    if (!userDoc || !userDoc.appointments?.length) {
      return NextResponse.json(
        { error: "Appointment not found" },
        { status: 404 },
      );
    }

    const appointment = userDoc.appointments[0];
    const fullName = `${userDoc.firstName} ${userDoc.lastName}`.trim();
    const {
      title,
      date: apptDate,
      time: apptTime,
    } = appointment;

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
        1: "صقر",
        2: title || "خدمة", 
        3: fullName || "غير معروف",
        4: apptDate,
        5: apptTime,
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
