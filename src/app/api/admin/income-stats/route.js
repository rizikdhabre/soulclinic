import { getCollection } from "@/lib/db";
import { NextResponse } from "next/server";

const MONTHS = [
  "01",
  "02",
  "03",
  "04",
  "05",
  "06",
  "07",
  "08",
  "09",
  "10",
  "11",
  "12",
];

const emptyMonths = () =>
  MONTHS.reduce((acc, m) => {
    acc[m] = 0;
    return acc;
  }, {});

/* ===================== GET ===================== */
export async function GET() {
  try {
    const users = await getCollection("usersData");
    const settings = await getCollection("settings");

    const year = new Date().getFullYear();

    const manual = await settings.findOne({
      key: "income",
      year,
    });

    const manualMonths = manual?.months || {};

    const result = await users
      .aggregate([
        { $unwind: "$appointments" },
        {
          $match: {
            "appointments.attended": true,
            "appointments.price": { $exists: true },
          },
        },
        {
          $addFields: {
            month: { $substr: ["$appointments.date", 0, 7] },
          },
        },
        {
          $group: {
            _id: "$month",
            income: { $sum: "$appointments.price" },
          },
        },
        { $sort: { _id: 1 } },
      ])
      .toArray();


    const incomeByMonth = {};

    result.forEach((r) => {
      const m = r._id.slice(5, 7);
      incomeByMonth[m] = (incomeByMonth[m] || 0) + r.income;
    });


    Object.keys(manualMonths).forEach((m) => {
      incomeByMonth[m] = (incomeByMonth[m] || 0) + manualMonths[m];
    });

    const final = Object.keys(incomeByMonth)
      .sort()
      .map((m) => ({
        month: `${year}-${m}`,
        income: incomeByMonth[m],
      }));

    return NextResponse.json(final);
  } catch (err) {
    console.error("Income stats error:", err);
    return NextResponse.json(
      { error: "Failed to fetch income stats" },
      { status: 500 },
    );
  }
}

/* ===================== POST ===================== */
export async function POST(req) {
  try {
    const { year, month, value } = await req.json();

    if (!year || !month || value === undefined) {
      return NextResponse.json({ error: "Missing data" }, { status: 400 });
    }

    const numericValue = Number(
      String(value).startsWith("+") || String(value).startsWith("-")
        ? value
        : `+${value}`,
    );

    if (Number.isNaN(numericValue)) {
      return NextResponse.json({ error: "Invalid value" }, { status: 400 });
    }

    const settings = await getCollection("settings");

    await settings.updateOne(
      { key: "income", year },
      {
        $setOnInsert: {
          key: "income",
          year,
          months: emptyMonths(),
          createdAt: new Date(),
        },
      },
      { upsert: true },
    );

    await settings.updateOne(
      { key: "income", year },
      {
        $inc: { [`months.${month}`]: numericValue },
        $set: { updatedAt: new Date() },
      },
    );

    return NextResponse.json({ success: true });
  } catch (err) {
    console.error("Income adjustment error:", err);
    return NextResponse.json(
      { error: "Failed to update income" },
      { status: 500 },
    );
  }
}
