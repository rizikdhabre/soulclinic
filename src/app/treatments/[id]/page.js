import { notFound } from "next/navigation";
import TreatmentClient from "./TreatmentClient";
import { getPublicTreatment } from "@/lib/catalogue/public";
import { treatmentPath } from "@/lib/catalogue/model";
import { pageMetadata } from "@/lib/seo/metadata";
import { treatmentSchema } from "@/lib/seo/schema";
import JsonLd from "@/components/seo/JsonLd";
import TreatmentBreadcrumbs from "@/components/seo/TreatmentBreadcrumbs";
export const dynamic = "force-dynamic";
async function resolve(params) {
  const { id } = await params;
  const record = await getPublicTreatment(id);
  if (!record) notFound();
  return record;
}
export async function generateMetadata({ params }) {
  const t = await resolve(params);
  return pageMetadata({ title: t.seoTitle || `${t.title} في دير حنا`, description: t.seoDescription || t.description, path: treatmentPath(t), image: t.services.find((s) => s.imageUrl)?.imageUrl, indexable: t.indexable });
}
export default async function Treatment({ params }) {
  const treatment = await resolve(params);
  return <main><TreatmentClient treatment={treatment}><TreatmentBreadcrumbs treatment={treatment} /></TreatmentClient><JsonLd data={treatmentSchema(treatment)} /></main>;
}
