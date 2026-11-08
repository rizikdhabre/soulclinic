import { describe, expect, it } from "vitest";
import {
  formatCuppingDate,
  formatCuppingLegend,
  getClinicDateKey,
  getCuppingMonth,
  getUpcomingCuppingDates,
} from "@/lib/hijriCuppingDates";

describe("Hijri cupping dates", () => {
  it("marks Gregorian dates corresponding to Hijri 17, 19 and 21, including past dates in that month", () => {
    const november = getCuppingMonth(2026, 10);
    expect(november.map(({ date, hijriDay }) => [date, hijriDay])).toEqual([
      ["2026-11-01", 21], ["2026-11-27", 17], ["2026-11-29", 19],
    ]);
    expect(formatCuppingLegend(november)).toBe("١•٢٧•٢٩");
  });

  it("updates the Gregorian legend across a year boundary and calculates beyond three months", () => {
    const december = getCuppingMonth(2026, 11);
    expect(december.map(({ day }) => day)).toEqual([1, 26, 28, 30]);
    expect(formatCuppingLegend(december)).toBe("١•٢٦•٢٨•٣٠");
    const january = getCuppingMonth(2027, 0);
    expect(january.map(({ date }) => date)).toEqual(["2027-01-25", "2027-01-27", "2027-01-29"]);
    expect(formatCuppingLegend(january)).toBe("٢٥•٢٧•٢٩");
    expect(getCuppingMonth(2027, 6).every(date => date.date.startsWith("2027-07-") && [17, 19, 21].includes(date.hijriDay))).toBe(true);
    expect(getCuppingMonth(2027, 6).length).toBeGreaterThan(0);
  });

  it("includes today when eligible and crosses months for the upcoming cards", () => {
    expect(getUpcomingCuppingDates("2026-11-27").map(({ date }) => date)).toEqual([
      "2026-11-27", "2026-11-29", "2026-12-01",
    ]);
    expect(getUpcomingCuppingDates("2026-11-28").map(({ date }) => date)).toEqual([
      "2026-11-29", "2026-12-01", "2026-12-26",
    ]);
  });

  it("formats a date-only value consistently, without shifting it to another civil day", () => {
    const date = formatCuppingDate("2026-11-27");
    expect(date).toMatchObject({ date: "2026-11-27", day: 27, hijriDay: 17, hijriMonth: "جمادى الآخرة", hijriYear: "1448", gregorianLabel: "27/11/2026", weekday: "الجمعة" });
    expect(date.hijriLabel).toContain("17");
    expect(date.hijriLabel).toContain("1448");
  });

  it("uses the clinic date at winter and summer midnight boundaries", () => {
    expect(getClinicDateKey(new Date("2026-11-08T21:59:59Z"))).toBe("2026-11-08");
    expect(getClinicDateKey(new Date("2026-11-08T22:00:00Z"))).toBe("2026-11-09");
    expect(getClinicDateKey(new Date("2027-06-01T20:59:59Z"))).toBe("2027-06-01");
    expect(getClinicDateKey(new Date("2027-06-01T21:00:00Z"))).toBe("2027-06-02");
  });

  it("reuses immutable cached month records and safely evicts older months", () => {
    const january = getCuppingMonth(2027, 0);
    expect(getCuppingMonth(2027, 0)).toBe(january);
    expect(Object.isFrozen(january)).toBe(true);
    expect(january.every(Object.isFrozen)).toBe(true);
    for (let month = 0; month < 30; month++) getCuppingMonth(2030 + Math.floor(month / 12), month % 12);
    expect(getCuppingMonth(2027, 0)).not.toBe(january);
    expect(getCuppingMonth(2027, 0)).toEqual(january);
  });

  it("rejects malformed civil dates instead of silently normalizing them", () => {
    expect(() => formatCuppingDate("2026-02-31")).toThrow();
    expect(() => formatCuppingDate("2026-1-1")).toThrow();
    expect(() => getCuppingMonth(2026, 12)).toThrow();
    expect(formatCuppingLegend([])).toBe("");
  });
});
