import { describe, expect, it } from "vitest";
import { getReminderRepeatAt } from "@/lib/returnReminderSchedule";

describe("repeat interval boundaries", () => {
  it.each([
    ["2026-01-31T10:00:00Z", 1, "months", "2026-02-28T10:00:00.000Z"],
    ["2024-01-31T10:00:00Z", 1, "months", "2024-02-29T10:00:00.000Z"],
    ["2026-07-31T09:00:00Z", 1, "months", "2026-08-31T09:00:00.000Z"],
    ["2026-10-24T16:00:25.123Z", 1, "days", "2026-10-25T17:00:25.123Z"],
    ["2026-03-26T17:00:00Z", 1, "days", "2026-03-27T16:00:00.000Z"],
    ["2026-03-26T00:30:00Z", 1, "days", "2026-03-27T00:30:00.000Z"],
    ["2026-10-23T22:30:00Z", 1, "days", "2026-10-24T23:30:00.000Z"],
  ])("preserves clinic calendar time: %s + %i %s", (anchor, value, unit, expected) => {
    expect(getReminderRepeatAt(new Date(anchor), { mode: "custom", value, unit }).toISOString()).toBe(expected);
  });
  it("retains default elapsed30day cooldown across DST", () => {
    expect(getReminderRepeatAt(new Date("2026-10-24T16:00:25.123Z"), { mode: "default" }).toISOString()).toBe("2026-11-23T16:00:25.123Z");
  });
});
