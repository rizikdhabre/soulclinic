import { ObjectId } from "mongodb";
import { describe, expect, it, vi } from "vitest";

const profile = await import("@/lib/adminCustomerProfile").catch(() => ({}));
const userId = new ObjectId("000000000000000000000011");
const pastId = new ObjectId("000000000000000000000021");
const futureId = new ObjectId("000000000000000000000022");
const now = new Date("2026-10-23T11:00:00Z");
const user = {
  _id: userId, firstName: "عميل", lastName: "تجريبي", phone: "+972521234567",
  adminNotes: [{ text: "private staff note" }],
  appointments: [
    { _id: pastId, date: "2026-10-22", time: "14:00", title: "علاج", price: 100, attended: true },
    { _id: futureId, date: "2026-10-23", time: "15:30", title: "جلسة أخرى", price: 150, attended: false },
    { _id: new ObjectId(), date: "invalid", time: "14:00", attended: false },
  ],
};
const canceledId = new ObjectId("000000000000000000000023");
const canceled = { _id: canceledId, date: "2026-10-25", time: "10:00", title: "جلسة ملغاة", price: 180 };
const makePlan = (appointments, extra = {}) => ({ _id: new ObjectId(), userId, createdAt: now, appointments, ...extra });
const calendarFor = (...appointments) => appointments.map((a) => ({ date: a.date, appointments: [{ _id: a._id, time: a.time }] }));

describe("protected customer profile projection", () => {
  it("defaults legacy program comments and exposes only safe fields from valid comments", () => {
    const commentId = "0ae84a16-93f5-49ae-a3c4-e12de257b9eb";
    const result = profile.projectCustomerProfile({ user, now, plans: [makePlan([], { adminComments: [
      { _id: commentId, text: "خاص\n<b>نص</b>", revision: 2, createdAt: now, updatedAt: now, providerSid: "PRIVATE_COMMENT_FIELD" },
      { _id: "invalid", text: "INVALID_COMMENT" },
    ], commentsVersion: 4 }), makePlan([])] });
    const withComments = result.plans.find((plan) => plan.commentsVersion === 4);
    expect(withComments?.comments).toEqual([{ _id: commentId, text: "خاص\n<b>نص</b>", revision: 2,
      createdAt: "2026-10-23T11:00:00.000Z", updatedAt: "2026-10-23T11:00:00.000Z" }]);
    expect(result.plans.find((plan) => plan !== withComments)).toMatchObject({ comments: [], commentsVersion: 0 });
    expect(JSON.stringify(result)).not.toMatch(/PRIVATE_COMMENT_FIELD|INVALID_COMMENT|adminComments/);
  });

  it("orders valid history newest first and supplies read-only attendance data", () => {
    expect(profile.projectCustomerProfile).toBeTypeOf("function");
    const result = profile.projectCustomerProfile({ user, feedbackRecords: [], plans: [], now });
    expect(result.user).toEqual({ _id: String(userId), firstName: "عميل", lastName: "تجريبي", phone: "+972521234567" });
    expect(result.appointments).toHaveLength(2);
    expect(result.appointments.map((a) => [a._id, a.isPast, a.attended])).toEqual([
      [String(futureId), false, false], [String(pastId), true, true],
    ]);
    expect(result.appointments.map((a) => a.status)).toEqual(["upcoming", "attended"]);
    expect(JSON.stringify(result)).not.toContain("private staff note");
  });

  it("joins only feedback owned by this customer and matching appointment, preserving plain text", () => {
    expect(profile.projectCustomerProfile).toBeTypeOf("function");
    const text = "تحسن جيد\n" + "كلمة".repeat(1000) + "<script>text only</script>";
    const result = profile.projectCustomerProfile({ user, now, plans: [], feedbackRecords: [
      { userId, appointmentId: pastId, tokenHash: "SECRET_HASH", feedback: { text, submittedAt: new Date("2026-10-23T09:00:00Z") } },
      { userId: new ObjectId(), appointmentId: futureId, feedback: { text: "other customer", submittedAt: now } },
    ] });
    expect(result.appointments.find((a) => a._id === String(pastId)).feedback).toEqual({ text, submittedAt: "2026-10-23T09:00:00.000Z" });
    expect(result.appointments.find((a) => a._id === String(futureId)).feedback).toBeNull();
    expect(JSON.stringify(result)).not.toContain("SECRET_HASH");
    expect(JSON.stringify(result)).not.toContain("other customer");
  });

  it("projects plan status without exposing provider IDs, hashes or raw internal fields", () => {
    expect(profile.projectCustomerProfile).toBeTypeOf("function");
    const result = profile.projectCustomerProfile({ user, now, feedbackRecords: [], plans: [{
      _id: new ObjectId(), userId, createdAt: now, payloadHash: "PRIVATE_HASH", phone: user.phone,
      notification: { status: "sent", providerSid: "PRIVATE_SID" },
      appointments: [{ _id: futureId, date: "2026-10-23", time: "15:30", title: "علاج" }],
    }] });
    expect(result.plans[0].notification).toEqual({ status: "sent" });
    expect(result.plans[0].appointments[0]).toMatchObject({ _id: String(futureId), title: "جلسة أخرى", price: 150 });
    expect(JSON.stringify(result)).not.toMatch(/PRIVATE_HASH|PRIVATE_SID/);
  });

  it("rejects invalid identifiers before accessing storage and missing customers as 404", async () => {
    expect(profile.getAdminCustomerProfile).toBeTypeOf("function");
    const db = { collection: vi.fn() };
    await expect(profile.getAdminCustomerProfile("bad", { db, now })).rejects.toMatchObject({ status: 400 });
    expect(db.collection).not.toHaveBeenCalled();
    db.collection.mockReturnValue({ findOne: vi.fn().mockResolvedValue(null) });
    await expect(profile.getAdminCustomerProfile(String(userId), { db, now })).rejects.toMatchObject({ status: 404 });
  });

  it("queries feedback and plans scoped to user ID without reading unrelated customer data", async () => {
    expect(profile.getAdminCustomerProfile).toBeTypeOf("function");
    const find = vi.fn(() => ({ toArray: async () => [] }));
    const db = { collection: vi.fn((name) => name === "usersData" ? { findOne: vi.fn().mockResolvedValue(user) } : { find }) };
    const result = await profile.getAdminCustomerProfile(String(userId), { db, now });
    expect(result.user._id).toBe(String(userId));
    expect(find.mock.calls.every(([filter]) => String(filter.userId) === String(userId))).toBe(true);
    expect(db.collection.mock.calls.flat().sort()).toEqual(["usersData", "appointmentFeedback", "treatmentPlans"].sort());
  });

  it("shows live and canceled plan appointments once, with chronological program details and mixed counts", () => {
    const result = profile.projectCustomerProfile({ user, now, calendarDays: calendarFor(user.appointments[1]),
      plans: [makePlan([canceled, user.appointments[1], user.appointments[0]])] });
    expect(result.appointments.map((a) => [a._id, a.status])).toEqual([
      [String(canceledId), "canceled"], [String(futureId), "upcoming"], [String(pastId), "attended"],
    ]);
    expect(result.plans[0]).toMatchObject({ status: "in_progress",
      counts: { total: 3, upcoming: 1, attended: 1, notAttended: 0, canceled: 1, unknown: 0 } });
    expect(result.plans[0].appointments.map((a) => a._id)).toEqual([String(pastId), String(futureId), String(canceledId)]);
    expect(result.appointments[0].bookingNote).toBe("");
  });

  it("retains all canceled sessions and previously submitted feedback without calling them upcoming", () => {
    const result = profile.projectCustomerProfile({ user: { ...user, appointments: [] }, now,
      plans: [makePlan([canceled])],
      feedbackRecords: [{ userId, appointmentId: canceledId, feedback: { text: "ملاحظة محفوظة", submittedAt: now } }] });
    expect(result.plans[0]).toMatchObject({ status: "canceled", counts: { total: 1, canceled: 1, upcoming: 0 } });
    expect(result.appointments[0]).toMatchObject({ status: "canceled", feedback: { text: "ملاحظة محفوظة" } });
  });

  it.each([
    ["upcoming", [{ ...user.appointments[1], attended: false }]],
    ["completed", [user.appointments[0]]],
    ["ended", [{ ...user.appointments[0], attended: false }]],
    ["in_progress", [{ ...user.appointments[0], attended: false }, user.appointments[1]]],
  ])("derives %s from attendance and clinic time, not elapsed dates alone", (status, appointments) => {
    const result = profile.projectCustomerProfile({ user: { ...user, appointments }, now,
      plans: [makePlan(appointments)], calendarDays: calendarFor(...appointments) });
    expect(result.plans[0].status).toBe(status);
  });

  it("can complete the remaining sessions while showing the canceled session count", () => {
    const result = profile.projectCustomerProfile({ user, now, plans: [makePlan([user.appointments[0], canceled])] });
    expect(result.plans[0]).toMatchObject({ status: "completed", counts: { total: 2, attended: 1, canceled: 1 } });
  });

  it("uses current live time, title and price after rescheduling, never duplicates the snapshot", () => {
    const moved = { ...user.appointments[1], time: "16:30", title: "العلاج الحالي", price: 230 };
    const result = profile.projectCustomerProfile({ user: { ...user, appointments: [moved] }, now,
      plans: [makePlan([user.appointments[1]])], calendarDays: calendarFor(moved) });
    expect(result.appointments).toHaveLength(1);
    expect(result.plans[0].appointments[0]).toMatchObject({ time: "16:30", title: "العلاج الحالي", price: 230, status: "upcoming" });
    expect(result.plans[0].appointments[0]).toEqual(result.appointments[0]);
  });

  it.each([
    ["calendar-only", [], calendarFor(canceled)],
    ["history-only future", [canceled], []],
    ["conflicting times", [canceled], calendarFor({ ...canceled, time: "11:00" })],
    ["malformed history", [{ ...canceled, date: "bad-date" }], []],
    ["duplicate calendar ID", [canceled], calendarFor(canceled, canceled)],
  ])("marks %s plan data as needing verification rather than claiming canceled or complete", (_label, appointments, calendarDays) => {
    const result = profile.projectCustomerProfile({ user: { ...user, appointments }, now, calendarDays, plans: [makePlan([canceled])] });
    expect(result.plans[0]).toMatchObject({ status: "unknown", counts: { unknown: 1 } });
    expect(result.appointments).toHaveLength(1);
    expect(result.appointments[0].status).toBe("unknown");
  });

  it("keeps malformed/empty plans uncertain and excludes other customers' plans", () => {
    const result = profile.projectCustomerProfile({ user, now, plans: [makePlan([]),
      makePlan([user.appointments[0], { ...canceled, time: "invalid" }]),
      makePlan([canceled], { userId: new ObjectId() })] });
    expect(result.plans).toHaveLength(2);
    expect(result.plans.every((plan) => plan.status === "unknown")).toBe(true);
    expect(result.plans.find((plan) => plan.counts.total === 2).counts).toMatchObject({ total: 2, attended: 1, unknown: 1 });
    expect(result.appointments.some((a) => a._id === String(canceledId))).toBe(false);
  });

  it("keeps booking notes and feedback separate and matches only current live slots", () => {
    const text = "ملاحظة الحجز\n" + "نص".repeat(1000) + "<b>plain text</b>";
    const moved = { ...user.appointments[1], time: "16:30" };
    const result = profile.projectCustomerProfile({ user: { ...user, appointments: [user.appointments[0], moved], notes: [
      { date: user.appointments[0].date, time: user.appointments[0].time, text },
      { date: user.appointments[0].date, time: user.appointments[0].time, text: "ملاحظة ثانية" },
      { date: moved.date, time: "15:30", text: "orphan old slot" },
      { date: canceled.date, time: canceled.time, text: "canceled orphan note" },
      { date: moved.date, time: moved.time, text: { private: "invalid note" } },
    ] }, now, calendarDays: calendarFor(moved), plans: [makePlan([user.appointments[1], canceled])],
    feedbackRecords: [{ userId, appointmentId: pastId, feedback: { text: "تقييم العلاج", submittedAt: now } }] });
    expect(result.appointments.find((a) => a._id === String(pastId))).toMatchObject({
      bookingNote: `${text}\n\nملاحظة ثانية`, feedback: { text: "تقييم العلاج" },
    });
    expect(result.appointments.find((a) => a._id === String(futureId)).bookingNote).toBe("");
    expect(JSON.stringify(result)).not.toMatch(/orphan|private staff note|invalid note/);
  });

  it("uses Israel local time at the appointment minute without labeling a future row missed", () => {
    const appointment = { ...user.appointments[1], time: "14:00" };
    expect(profile.projectCustomerProfile({ user: { ...user, appointments: [appointment] }, now }).appointments[0].status).toBe("not_attended");
    expect(profile.projectCustomerProfile({ user: { ...user, appointments: [appointment] }, now: new Date("2026-10-23T10:59:00Z") }).appointments[0].status).toBe("upcoming");
  });

  it("does not attach an orphan standalone booking note to a new plan session reusing that time", () => {
    const moved = { ...user.appointments[1], time: "16:30" };
    const planSession = { ...user.appointments[1], _id: canceledId };
    const result = profile.projectCustomerProfile({ user: { ...user, appointments: [moved, planSession],
      notes: [{ date: moved.date, time: "15:30", text: "belongs to the moved standalone booking" }] }, now,
      plans: [makePlan([planSession])], calendarDays: calendarFor(planSession) });
    expect(result.appointments.every((a) => a.bookingNote === "")).toBe(true);
    expect(result.plans[0].appointments[0].bookingNote).toBe("");
  });

  it("queries owned plan calendar slots and feedback for recoverable canceled IDs, with only public note fields", async () => {
    const plan = makePlan([canceled]);
    const finds = {};
    const findOne = vi.fn().mockResolvedValue(user);
    const db = { collection: vi.fn((name) => {
      if (name === "usersData") return { findOne };
      const find = vi.fn(() => ({ toArray: async () => name === "treatmentPlans" ? [plan] : [] }));
      finds[name] = find;
      return { find };
    }) };
    const result = await profile.getAdminCustomerProfile(String(userId), { db, now });
    expect(result.plans[0].status).toBe("canceled");
    expect(findOne.mock.calls[0][1].projection).toMatchObject({ notes: 1 });
    expect(findOne.mock.calls[0][1].projection).not.toHaveProperty("adminNotes");
    expect(finds.treatmentPlans.mock.calls[0][0]).toEqual({ userId });
    const feedbackFilter = finds.appointmentFeedback.mock.calls[0][0];
    expect(feedbackFilter.userId).toEqual(userId);
    expect(feedbackFilter.appointmentId.$in.map(String).sort()).toEqual([pastId, futureId, canceledId].map(String).sort());
    expect(finds.appointments.mock.calls[0][0]).toEqual({ "appointments._id": { $in: [canceledId] } });
    expect(finds.appointments.mock.calls[0][1].projection).toEqual({ date: 1, "appointments._id": 1, "appointments.time": 1 });
  });
});
