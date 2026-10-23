export const PUBLIC_FILTER = { $or: [{ status: "published" }, { status: { $exists: false } }] };
export const isPublic = (record) => Boolean(record) && (record.status === undefined || record.status === "published");
export const isIndexable = (record) => isPublic(record) && record.indexable !== false;
export const validId = (value) => typeof value === "string" && /^[a-f0-9]{24}$/i.test(value);
export const treatmentPath = (record) => "/treatments/" + encodeURIComponent(String(record._id));
export function publicImage(value) {
  if (typeof value !== "string") return undefined;
  if (value.startsWith("/") && !value.startsWith("//")) return value;
  try { const url = new URL(value); return url.protocol === "https:" && url.hostname === "storage.googleapis.com" ? url.href : undefined; }
  catch { return undefined; }
}
export function publicTreatment(record) {
  if (!isPublic(record)) return null;
  return {
    _id: String(record._id), title: record.title || "", description: record.description || "",
    indexable: record.indexable !== false,
    seoTitle: record.seoTitle || "", seoDescription: record.seoDescription || "",
    details: record.details || "", updatedAt: record.updatedAt ? new Date(record.updatedAt).toISOString() : null,
    services: (record.services || []).filter(isPublic).map((s) => ({
      title: s.title || "", description: s.description || "", duration: s.duration,
      price: s.price, currency: s.currency, cupsCount: s.cupsCount,
      imageUrl: publicImage(s.imageUrl), imageAlt: s.imageAlt || s.title || "",
    })),
  };
}
