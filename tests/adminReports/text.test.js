import { describe, expect, it } from "vitest";

const { buildAdminReportText } = await import("@/lib/adminDailyReportText").catch(() => ({}));

describe("admin report text", () => {
  it("puts all appointments in one numbered variable without any private metadata", () => {
    const result = buildAdminReportText("appointments", [
      { name: "أحمد علي", phone: "+972500000000", title: "حجامة", time: "10:30", adminNote: "SECRET" },
      { name: "محمد حسن", phone: "+972520000000", title: "إبر صينية", time: "12:00" },
    ]);
    expect(result).toMatchObject({ count: 2, fits: true,
      text: "1) أحمد علي | +972500000000 | حجامة | 10:30 ║ 2) محمد حسن | +972520000000 | إبر صينية | 12:00" });
    expect(result.characters).toBe(`📅 مواعيد الغد — SoulClinic\n\n${result.text}\n\nانتهى الجدول.`.length);
    expect(result.text).not.toContain("SECRET");
  });

  it("preserves complete feedback with a legacy score/comment fallback", () => {
    expect(buildAdminReportText("feedback", [
      { name: "أحمد علي", title: "حجامة", painRelief: 8, text: "تحسّن واضح 🤲🏼" },
      { name: "محمد حسن", title: "إبر صينية", painRelief: "9", text: "" },
    ])).toMatchObject({ count: 2, fits: true,
      text: "1) أحمد علي | حجامة | 8/10 | تحسّن واضح 🤲🏼 ║ 2) محمد حسن | إبر صينية | غير متوفر | بدون ملاحظة" });
  });

  it("normalizes all field whitespace and prevents injected field/list separators", () => {
    const result = buildAdminReportText("feedback", [{
      name: " أحمد\n\tعلي ", title: " حجامة\u00a0\u00a0وعلاج ", painRelief: 10,
      text: " تحسنت\nكثيرًا\t║ 2) اسم مزيف | 1/10 ",
    }]);
    expect(result.text).toBe("1) أحمد علي | حجامة وعلاج | 10/10 | تحسنت كثيرًا / 2) اسم مزيف / 1/10");
    expect(result.text).not.toMatch(/[\n\r\t]/);
    expect(result.text.match(/\|/g)).toHaveLength(3);
    expect(result.text).not.toContain("║");
  });

  it.each(["appointments", "feedback"])("states an empty %s report explicitly", (type) => {
    const result = buildAdminReportText(type, []);
    expect(result).toMatchObject({ count: 0, fits: true,
      text: type === "appointments" ? "لا توجد مواعيد للغد." : "لا توجد تقييمات جديدة منذ التقرير السابق." });
  });

  it.each(["appointments", "feedback"])("counts the entire %s template and never splits or truncates", (type) => {
    const row = type === "appointments"
      ? { name: "a", phone: "b", title: "c", time: "10:00" }
      : { name: "a", title: "b", painRelief: 8, text: "c" };
    const key = type === "appointments" ? "name" : "text";
    const base = buildAdminReportText(type, [row]);
    row[key] += "ع".repeat(1600 - base.characters);
    expect(buildAdminReportText(type, [row])).toMatchObject({ characters: 1600, fits: true });
    row[key] += "ع";
    const overflow = buildAdminReportText(type, [row]);
    expect(overflow).toMatchObject({ characters: 1601, fits: false, count: 1 });
    expect(overflow.text).toContain(row[key]);
  });

  it("counts emoji conservatively as UTF-16 and leaves old long feedback intact", () => {
    const text = "🤲🏼".repeat(500);
    const result = buildAdminReportText("feedback", [{ name: "عميل", title: "حجامة", painRelief: 1, text }]);
    expect(result.fits).toBe(false);
    expect(result.text).toContain(text);
    expect(result.characters).toBe(`📝 تقييمات الزبائن — SoulClinic\n\n${result.text}\n\nالتقييمات الجديدة منذ التقرير السابق.`.length);
  });

  it("rejects unknown report types instead of silently choosing a template", () => {
    expect(() => buildAdminReportText("unknown", [])).toThrow("INVALID_ADMIN_REPORT_TYPE");
  });
});
