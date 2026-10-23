import { describe, expect, it } from "vitest";

const rules = await import("@/lib/monthlyScheduleRules").catch(() => ({}));
const NOW = new Date("2026-10-23T07:00:00Z");
const input = (overrides = {}) => ({ month: "2026-11", groups: [{ weekdays: [1, 3], mode: "times", times: ["10:00", "11:00", "14:00"], blockedTimes: ["14:00"] }], excludedDates: [], customizedDays: "preserve", ...overrides });
function normalize(value) {
  expect(rules.normalizeMonthlySchedule).toBeTypeOf("function");
  return rules.normalizeMonthlySchedule(value);
}
function preview(value, documents = [], now = NOW) {
  expect(rules.buildMonthlySchedulePreview).toBeTypeOf("function");
  return rules.buildMonthlySchedulePreview(normalize(value), documents, now);
}

describe("monthly schedule validation and preview", () => {
  it.each([
    ["invalid month", { month: "2026-13" }], ["nonpadded month", { month: "2026-1" }],
    ["missing groups", { groups: [] }], ["overlapping weekdays", { groups: [{ weekdays: [1], mode: "closed" }, { weekdays: [1], mode: "closed" }] }],
    ["repeated weekday", { groups: [{ weekdays: [1, 1], mode: "closed" }] }], ["empty weekdays", { groups: [{ weekdays: [], mode: "closed" }] }],
    ["invalid weekday", { groups: [{ weekdays: [7], mode: "closed" }] }], ["noninteger weekday", { groups: [{ weekdays: ["1"], mode: "closed" }] }],
    ["invalid mode", { groups: [{ weekdays: [1], mode: "default" }] }],
    ["empty times", { groups: [{ weekdays: [1], mode: "times", times: [], blockedTimes: [] }] }],
    ["nonpadded time", { groups: [{ weekdays: [1], mode: "times", times: ["9:00"], blockedTimes: [] }] }],
    ["early time", { groups: [{ weekdays: [1], mode: "times", times: ["09:59"], blockedTimes: [] }] }],
    ["late time", { groups: [{ weekdays: [1], mode: "times", times: ["19:31"], blockedTimes: [] }] }],
    ["duplicate times", { groups: [{ weekdays: [1], mode: "times", times: ["10:00", "10:00"], blockedTimes: [] }] }],
    ["invalid minutes", { groups: [{ weekdays: [1], mode: "times", times: ["10:60"], blockedTimes: [] }] }],
    ["foreign blocked start", { groups: [{ weekdays: [1], mode: "times", times: ["10:00"], blockedTimes: ["11:00"] }] }],
    ["duplicate blocked start", { groups: [{ weekdays: [1], mode: "times", times: ["10:00"], blockedTimes: ["10:00", "10:00"] }] }],
    ["closed with time arrays", { groups: [{ weekdays: [1], mode: "closed", times: [] }] }],
    ["outside month exclusion", { excludedDates: ["2026-12-01"] }], ["invalid exclusion", { excludedDates: ["2026-11-31"] }],
    ["duplicate exclusion", { excludedDates: ["2026-11-02", "2026-11-02"] }],
    ["overlarge times", { groups: [{ weekdays: [1], mode: "times", times: Array.from({ length: 41 }, (_, i) => `10:${String(i).padStart(2, "0")}`), blockedTimes: [] }] }],
  ])("rejects %s before generating a proposal", (_name, overrides) => {
    expect(() => normalize(input(overrides))).toThrow(expect.objectContaining({ code: "INVALID_SCHEDULE", status: 400 }));
  });

  it("canonicalizes order while retaining each group's zero-based identity and allows arbitrary exact starts", () => {
    const request = input({ groups: [{ weekdays: [3, 1], mode: "times", times: ["19:30", "10:15", "10:00"], blockedTimes: ["10:15"] }] });
    expect(normalize(request).groups[0]).toEqual({ weekdays: [1, 3], mode: "times", times: ["10:00", "10:15", "19:30"], blockedTimes: ["10:15"] });
    const result = preview(request);
    expect(result.days.map((day) => day.date)).toEqual(["2026-11-02", "2026-11-04", "2026-11-09", "2026-11-11", "2026-11-16", "2026-11-18", "2026-11-23", "2026-11-25", "2026-11-30"]);
    expect(result.days.every((day) => day.groupIndex === 0 && day.status === "apply")).toBe(true);
    expect(result.summary).toEqual({ apply: 9, skipped: 0, existingAppointments: 0, affectedAppointments: 0 });
  });

  it("replaces customized days while skipping excluded and invalid days without exposing customers", () => {
    const documents = [
      { date: "2026-11-02", appointments: [{ time: "10:30", duration: 60, phone: "secret", firstName: "private" }, { time: "14:00" }, { time: "10:00", duration: 120 }] },
      { date: "2026-11-09", blockedTimes: ["11:00"], appointments: [{ time: "12:00" }] },
      { date: "2026-11-16", editedTimes: "broken" },
    ];
    const result = preview(input({ excludedDates: ["2026-11-11"] }), documents);
    expect(result.days.find((day) => day.date === "2026-11-02")).toMatchObject({ appointmentCount: 3, affectedAppointmentCount: 2, nextTimes: ["10:00", "11:00", "14:00"], nextBlockedTimes: ["14:00"] });
    expect(result.days.find((day) => day.date === "2026-11-09")).toMatchObject({ status: "apply", affectedAppointmentCount: 1, nextBlockedTimes: ["14:00"] });
    expect(result.days.find((day) => day.date === "2026-11-11")).toMatchObject({ status: "excluded" });
    expect(result.days.find((day) => day.date === "2026-11-16")).toMatchObject({ status: "invalid" });
    expect(result.summary).toEqual({ apply: 7, skipped: 2, existingAppointments: 4, affectedAppointments: 3 });
    expect(result.conflicts).toEqual([{ date: "2026-11-02", time: "10:30" }, { date: "2026-11-02", time: "14:00" }, { date: "2026-11-09", time: "12:00" }]);
    expect(result.canApply).toBe(false);
    expect(JSON.stringify(result)).not.toMatch(/secret|private|duration|phone|firstName/);
  });

  it("ignores the removed preservation option in canonical intent and preview tokens", () => {
    const documents = [{ date: "2026-11-02", blockedTimes: ["10:00"] }];
    const ordinary = preview(input({ customizedDays: undefined }), documents);
    for (const customizedDays of ["preserve", "replace", "obsolete", { ignored: true }]) {
      expect(normalize(input({ customizedDays }))).not.toHaveProperty("customizedDays");
      expect(preview(input({ customizedDays }), documents)).toEqual(ordinary);
    }
    expect(ordinary.days[0].status).toBe("apply");
    expect(ordinary.canApply).toBe(true);
  });

  it("reports only exact booked starts removed or blocked, not adjacent duration overlaps", () => {
    const result = preview(input(), [{ date: "2026-11-02", appointments: [
      { time: "10:00", duration: 240 }, { time: "14:00" }, { time: "14:00" },
    ] }]);
    expect(result.conflicts).toEqual([{ date: "2026-11-02", time: "14:00" }]);
    expect(result.summary.affectedAppointments).toBe(2);
    const compatible = preview(input({ groups: [{ weekdays: [1], mode: "times", times: ["10:00", "11:00"], blockedTimes: ["11:00"] }] }), [
      { date: "2026-11-02", appointments: [{ time: "10:00", duration: 240 }] },
    ]);
    expect(compatible).toMatchObject({ conflicts: [], canApply: true });
  });

  it("does not report appointment conflicts for excluded or past dates and cannot apply an empty set", () => {
    const excluded = preview(input({ excludedDates: ["2026-11-02"] }), [{ date: "2026-11-02", appointments: [{ time: "14:00" }] }]);
    expect(excluded).toMatchObject({ conflicts: [], canApply: true });
    const past = preview(input({ month: "2026-09" }), [{ date: "2026-09-07", appointments: [{ time: "14:00" }] }]);
    expect(past).toMatchObject({ conflicts: [], canApply: false });
  });

  it("closes effective starts including booked starts and retains hidden existing blocks", () => {
    const result = preview(input({ groups: [{ weekdays: [1], mode: "closed" }], customizedDays: "replace" }), [
      { date: "2026-11-02", editedTimes: ["10:15", "12:00"], blockedTimes: ["11:00", "21:00"], appointments: [{ time: "12:00", duration: 60 }] },
    ]);
    expect(result.days[0]).toMatchObject({ nextTimes: ["10:15", "12:00"], nextBlockedTimes: ["10:15", "11:00", "12:00", "21:00"], appointmentCount: 1, affectedAppointmentCount: 1 });
    expect(result.days[1].nextTimes).toHaveLength(20);
    expect(result.days[1].nextBlockedTimes).toEqual(result.days[1].nextTimes);
  });

  it.each([
    { editedTimes: null }, { editedTimes: ["bad"] }, { editedTimes: ["09:00"] }, { blockedTimes: "bad" },
    { blockedTimes: ["10:00", "10:00"] }, { appointments: "bad" }, { appointments: [null] }, { appointments: [{ time: "bad" }] },
  ])("never replaces malformed legacy day data %j", (malformed) => {
    const result = preview(input({ customizedDays: "replace" }), [{ date: "2026-11-02", ...malformed }]);
    expect(result.days[0]).toMatchObject({ status: "invalid", affectedAppointmentCount: 0 });
    expect(result.summary.apply).toBe(8);
  });

  it("uses clinic midnight to skip past dates and includes today", () => {
    const request = input({ month: "2026-10", groups: [{ weekdays: [5, 6], mode: "closed" }] });
    const beforeMidnight = preview(request, [], new Date("2026-10-23T20:59:00Z"));
    const afterMidnight = preview(request, [], new Date("2026-10-23T21:01:00Z"));
    expect(beforeMidnight.days.find((day) => day.date === "2026-10-23").status).toBe("apply");
    expect(afterMidnight.days.find((day) => day.date === "2026-10-23").status).toBe("past");
    expect(afterMidnight.days.find((day) => day.date === "2026-10-24").status).toBe("apply");
    expect(afterMidnight.previewToken).not.toBe(beforeMidnight.previewToken);
  });

  it("hashes relevant appointment state, schedule and identity but ignores unknown day metadata and array input order", () => {
    const day = { _id: "day", date: "2026-11-02", appointments: [{ _id: "apt", time: "10:00", duration: 60 }], editedTimes: [], blockedTimes: [] };
    const original = preview(input(), [day]);
    expect(original.previewToken).toMatch(/^[a-f\d]{64}$/);
    expect(preview(input(), [{ ...day, note: "irrelevant" }]).previewToken).toBe(original.previewToken);
    expect(preview(input({ groups: [{ weekdays: [3, 1], mode: "times", times: ["14:00", "10:00", "11:00"], blockedTimes: ["14:00"] }] }), [day]).previewToken).toBe(original.previewToken);
    expect(preview(input(), [{ ...day, appointments: [{ ...day.appointments[0], duration: 30 }] }]).previewToken).not.toBe(original.previewToken);
    expect(preview(input(), [{ ...day, blockedTimes: ["10:00"] }]).previewToken).not.toBe(original.previewToken);
    expect(preview(input(), [{ ...day, _id: "replacement" }]).previewToken).not.toBe(original.previewToken);
  });
});
