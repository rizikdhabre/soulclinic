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

describe("protected customer profile projection", () => {
  it("orders valid history newest first and supplies read-only attendance data", () => {
    expect(profile.projectCustomerProfile).toBeTypeOf("function");
    const result = profile.projectCustomerProfile({ user, feedbackRecords: [], plans: [], now });
    expect(result.user).toEqual({ _id: String(userId), firstName: "عميل", lastName: "تجريبي", phone: "+972521234567" });
    expect(result.appointments).toHaveLength(2);
    expect(result.appointments.map((a) => [a._id, a.isPast, a.attended])).toEqual([
      [String(futureId), false, false], [String(pastId), true, true],
    ]);
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
    expect(result.plans[0].appointments[0]).toMatchObject({ _id: String(futureId), title: "علاج" });
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
    expect(db.collection.mock.calls.flat()).toEqual(["usersData", "appointmentFeedback", "treatmentPlans"]);
  });
});
