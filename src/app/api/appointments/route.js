import { getCollection } from "@/lib/db";
import { NextResponse } from "next/server";
import { ObjectId } from "mongodb";
import { sendWhatsAppTemplate } from "@/lib/whatsapp";
/* ---------------- HELPER ---------------- */

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
  const usersCollection = await getCollection("usersData");
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

  const existingUser = await usersCollection.findOne(
    { phone },
    { projection: { firstName: 1, lastName: 1 } },
  );
  const adminFirstName = existingUser?.firstName || firstName;
  const adminLastName = existingUser?.lastName || lastName;
  const adminFullName = `${adminFirstName || ""} ${adminLastName || ""}`.trim();

  if (!existingUser) {
    await usersCollection.insertOne({
      phone,
      firstName,
      lastName,
      appointments: [appointmentEntry],
      notes: noteEntry ? [noteEntry] : [],
      createdAt: new Date(),
    });
  } else {
    const update = {
      $push: {
        appointments: appointmentEntry,
      },
    };

    if (noteEntry) {
      update.$push.notes = noteEntry;
    }

    await usersCollection.updateOne({ phone }, update);
  }

  try {
    await sendAppointmentConfirmationToCustomer({
      phone,
      adminFirstName,
      adminLastName,
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
    console.error("WhatsApp admin notify failed:", err);
  }
}

/* ---------------- GET ---------------- */

export async function GET(req) {
  try {
    const { searchParams } = new URL(req.url);
    const date = searchParams.get("date");
    const isAdmin = searchParams.get("admin") === "true";

    if (!date) return NextResponse.json([]);

    const collection = await getCollection("appointments");

    const day = await collection.findOne(
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
        },
      },
    );

    if (!day) {
      return NextResponse.json(
        isAdmin ? { appointments: [], blockedTimes: [] } : [],
      );
    }

    if (isAdmin) {
      return NextResponse.json({
        appointments: day.appointments || [],
        blockedTimes: day.blockedTimes || [],
        editedTimes: day.editedTimes || [],
      });
    }

    return NextResponse.json({
      appointments: day.appointments || [],
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

    if (!firstName || !lastName || !phone || !date || !time) {
      return NextResponse.json({ error: "Missing fields" }, { status: 400 });
    }

    const appointmentsCollection = await getCollection("appointments");
    const appointmentId = new ObjectId();
    const appointmentData = {
      _id: appointmentId,
      firstName,
      lastName,
      phone,
      time,
      duration,
      ...(cupsCount ? { cupsCount } : {}),
    };

    await appointmentsCollection.findOneAndUpdate(
      { date },
      {
        $push: {
          appointments: appointmentData,
        },
      },
      {
        upsert: true,
      },
    );
    await upsertUserData({
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
    });
    return NextResponse.json({ success: true });
  } catch (error) {
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
