import {
  DEFAULT_SLOTS,
  SLOT_MINUTES,
  getDurationMinutes,
  toMinutes,
} from "./appointmentRules";

let appointmentsDateIndexPromise = null;

function isDuplicateKeyError(error) {
  return error?.code === 11000;
}

export async function ensureAppointmentsDateIndex(collection) {
  if (!appointmentsDateIndexPromise) {
    appointmentsDateIndexPromise = collection
      .createIndex(
        { date: 1 },
        { unique: true, name: "unique_appointment_date" },
      )
      .catch((error) => {
        console.error("Failed to ensure appointments date index:", error);
        return null;
      });
  }

  return appointmentsDateIndexPromise;
}

export async function ensureDayDocument(collection, date, options = {}) {
  try {
    await collection.updateOne(
      { date },
      {
        $setOnInsert: {
          date,
          appointments: [],
          blockedTimes: [],
          editedTimes: [],
        },
      },
      { upsert: true, ...options },
    );
  } catch (error) {
    if (!isDuplicateKeyError(error)) throw error;
  }
}

function mongoConvertToIntExpression(input, fallback = null) {
  return {
    $convert: {
      input,
      to: "int",
      onError: fallback,
      onNull: fallback,
    },
  };
}

function mongoTimeToMinutesExpression(timeExpression) {
  return {
    $let: {
      vars: {
        parts: { $split: [{ $ifNull: [timeExpression, ""] }, ":"] },
      },
      in: {
        $let: {
          vars: {
            hours: mongoConvertToIntExpression(
              { $arrayElemAt: ["$$parts", 0] },
              null,
            ),
            minutes: mongoConvertToIntExpression(
              { $arrayElemAt: ["$$parts", 1] },
              null,
            ),
          },
          in: {
            $cond: [
              {
                $or: [
                  { $eq: ["$$hours", null] },
                  { $eq: ["$$minutes", null] },
                ],
              },
              null,
              { $add: [{ $multiply: ["$$hours", 60] }, "$$minutes"] },
            ],
          },
        },
      },
    },
  };
}

function mongoPositiveDurationExpression(durationExpression) {
  return {
    $let: {
      vars: {
        duration: mongoConvertToIntExpression(
          durationExpression,
          SLOT_MINUTES,
        ),
      },
      in: {
        $cond: [
          { $gt: ["$$duration", 0] },
          "$$duration",
          SLOT_MINUTES,
        ],
      },
    },
  };
}

export function buildAtomicAvailabilityFilter({
  date,
  time,
  duration,
  ignoreAppointmentId,
}) {
  const start = toMinutes(time);
  const safeDuration = getDurationMinutes(duration);
  const end = start + safeDuration;

  const appointmentOverlapConditions = [
    { $lt: ["$$aptStart", end] },
    {
      $gt: [
        { $add: ["$$aptStart", "$$aptDuration"] },
        start,
      ],
    },
  ];

  if (ignoreAppointmentId) {
    appointmentOverlapConditions.unshift({
      $ne: [{ $toString: "$$apt._id" }, String(ignoreAppointmentId)],
    });
  }

  return {
    date,
    $expr: {
      $and: [
        {
          $in: [
            time,
            {
              $cond: [
                { $gt: [{ $size: { $ifNull: ["$editedTimes", []] } }, 0] },
                "$editedTimes",
                DEFAULT_SLOTS,
              ],
            },
          ],
        },
        {
          $not: [
            { $in: [time, { $ifNull: ["$blockedTimes", []] }] },
          ],
        },
        {
          $eq: [
            {
              $size: {
                $filter: {
                  input: { $ifNull: ["$appointments", []] },
                  as: "apt",
                  cond: {
                    $let: {
                      vars: {
                        aptStart: mongoTimeToMinutesExpression("$$apt.time"),
                        aptDuration: mongoPositiveDurationExpression(
                          "$$apt.duration",
                        ),
                      },
                      in: {
                        $and: [
                          { $ne: ["$$aptStart", null] },
                          ...appointmentOverlapConditions,
                        ],
                      },
                    },
                  },
                },
              },
            },
            0,
          ],
        },
      ],
    },
  };
}
