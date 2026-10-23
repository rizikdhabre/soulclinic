import { describe, expect, it } from "vitest";

const time = await import("@/lib/clinicTime").catch(() => ({}));

describe("clinic local date rules", () => {
  it("uses Jerusalem rather than the host timezone across midnight and DST", () => {
    expect(time.getClinicNowParts).toBeTypeOf("function");
    expect(time.getClinicNowParts(new Date("2026-10-23T21:30:00Z"))).toEqual({ date: "2026-10-24", time: "00:30" });
    expect(time.getClinicNowParts(new Date("2026-12-01T12:00:00Z"))).toEqual({ date: "2026-12-01", time: "14:00" });
  });

  it("rejects impossible dates, malformed times and normalized rollover dates", () => {
    expect(time.isValidClinicDate).toBeTypeOf("function");
    for (const date of ["2026-02-29", "2026-04-31", "2026-13-01", "23.10.2026", null, "2026-1-01"]) {
      expect(time.isValidClinicDate(date)).toBe(false);
    }
    expect(time.isValidClinicDate("2028-02-29")).toBe(true);
    for (const value of ["24:00", "10:60", "9:00", "14:00:00", null]) expect(time.isValidClinicTime(value)).toBe(false);
    expect(time.isValidClinicTime("14:00")).toBe(true);
  });

  it("compares appointment start to clinic time rather than midnight only", () => {
    expect(time.compareAppointmentToNow).toBeTypeOf("function");
    const now = new Date("2026-10-23T11:00:00Z");
    expect(time.compareAppointmentToNow({ date: "2026-10-23", time: "13:30" }, now)).toBe(-1);
    expect(time.compareAppointmentToNow({ date: "2026-10-23", time: "14:00" }, now)).toBe(0);
    expect(time.compareAppointmentToNow({ date: "2026-10-23", time: "14:30" }, now)).toBe(1);
    expect(() => time.compareAppointmentToNow({ date: "invalid", time: "14:00" }, now)).toThrow();
  });
});
