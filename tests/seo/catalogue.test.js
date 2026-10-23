import { describe, it, expect, vi } from "vitest";
import { publicTreatment, treatmentPath } from "@/lib/catalogue/model";
import { serializeJsonLd, treatmentSchema } from "@/lib/seo/schema";
import { pageMetadata } from "@/lib/seo/metadata";
import robots from "@/app/robots";

describe("public catalogue boundaries", () => {
  it("keeps preview indexing policy separate from production defaults", () => {
    try {
      vi.stubEnv("VERCEL_ENV", "preview");
      expect(pageMetadata({ title: "Test", description: "Test", path: "/" }).robots.index).toBe(false);
      expect(robots().rules.disallow).toBe("/");
      vi.stubEnv("VERCEL_ENV", "production"); vi.stubEnv("SITE_NOINDEX", "");
      expect(pageMetadata({ title: "Test", description: "Test", path: "/" }).robots.index).toBe(true);
      expect(robots().rules.allow).toBe("/");
    } finally { vi.unstubAllEnvs(); }
  });
  it("retains legacy visibility but rejects drafts and unexpected states", () => {
    expect(publicTreatment({ _id: "id", status: "draft" })).toBeNull();
    expect(publicTreatment({ _id: "id", status: "hidden" })).toBeNull();
    expect(publicTreatment({ _id: "id" })._id).toBe("id");
  });
  it("never serializes private fields, stored image paths or draft options", () => {
    const result = publicTreatment({ _id: "id", privateNotes: "secret", routeKeys: ["history"], services: [
      { title: "Visible", imagePath: "private/path", internalNote: "secret", price: "20", currency: "ILS" },
      { title: "hidden", status: "draft" },
    ] });
    expect(JSON.stringify(result)).not.toMatch(/secret|private\/path|history|hidden/);
    expect(result.services).toHaveLength(1);
    expect(treatmentSchema(result).hasOfferCatalog.itemListElement[0].price).toBe(20);
  });
  it("keeps existing ID URLs across content and title changes", () => {
    const record = { _id: "000000000000000000000001", title: "Original" };
    expect(treatmentPath(record)).toBe("/treatments/000000000000000000000001");
    expect(treatmentPath({ ...record, title: "Changed", slug: "ignored-new-url" })).toBe("/treatments/000000000000000000000001");
  });
  it("escapes script terminators while preserving JSON content", () => {
    const payload = { name: "</script><script>alert(1)</script>" };
    const serialized = serializeJsonLd(payload);
    expect(serialized).not.toContain("<");
    expect(JSON.parse(serialized)).toEqual(payload);
  });
  it("uses one absolute canonical and synchronized social metadata", () => {
    const meta = pageMetadata({ title: "اتصل بنا", description: "وصف", path: "/contact" });
    expect(meta.alternates.canonical).toBe("https://soulclinc.net/contact");
    expect(meta.openGraph.title).toBe(meta.twitter.title);
    expect(meta.title.absolute).toBe("اتصل بنا | SOUL Clinic");
    expect(meta.openGraph.images[0].url).toBe("https://soulclinc.net/opengraph-image");
  });
});
