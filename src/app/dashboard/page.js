import DashboardClient from "./DashboardClient";
import { getPublicTreatments } from "@/lib/catalogue/public";
import { treatmentPath } from "@/lib/catalogue/model";
import { pageMetadata } from "@/lib/seo/metadata";
import { absoluteUrl } from "@/lib/seo/business";
import JsonLd from "@/components/seo/JsonLd";

export const dynamic = "force-dynamic";
export const metadata = pageMetadata({ title: "الحجامة والمساج وخدمات العيادة في دير حنا", description: "تعرّف على خدمات عيادة SOUL في دير حنا. قارن خيارات الجلسات ومدتها وأسعارها، واطّلع على التفاصيل قبل الحجز.", path: "/dashboard" });
export default async function Dashboard() {
  const records = await getPublicTreatments();
  return <main><DashboardClient treatments={records} /><JsonLd data={{ "@type": "CollectionPage", url: absoluteUrl("/dashboard"), name: "علاجاتنا", mainEntity: { "@type": "ItemList", itemListElement: records.map((t, i) => ({ "@type": "ListItem", position: i + 1, name: t.title, url: absoluteUrl(treatmentPath(t)) })) } }} /></main>;
}
