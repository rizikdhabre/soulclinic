import { absoluteUrl } from "@/lib/seo/business";
import { getPublicTreatments } from "@/lib/catalogue/public";
import { treatmentPath } from "@/lib/catalogue/model";
export const dynamic = "force-dynamic";
export default async function sitemap() {
  const treatments = await getPublicTreatments();
  return [
    ...["/", "/about", "/contact", "/dashboard"].map((path) => ({ url: absoluteUrl(path) })),
    ...treatments.filter((t) => t.indexable).map((t) => ({ url: absoluteUrl(treatmentPath(t)), ...(t.updatedAt ? { lastModified: t.updatedAt } : {}) })),
  ];
}
