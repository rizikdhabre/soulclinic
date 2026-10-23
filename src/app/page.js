import HomeClient from "@/components/home/HomeClient";
import { getHeroImage } from "@/lib/catalogue/public";
import { pageMetadata } from "@/lib/seo/metadata";
import { websiteSchema } from "@/lib/seo/schema";
import JsonLd from "@/components/seo/JsonLd";
export const dynamic = "force-dynamic";
export const metadata = pageMetadata({ title: "عيادة SOUL للحجامة والمساج والإبر الصينية في دير حنا", description: "عيادة SOUL في دير حنا: اكتشف جلسات الحجامة والمساج والإبر الصينية وخيارات العناية، مع تفاصيل الأسعار والمدة وحجز المواعيد.", path: "/" });
export default async function Home() {
  const heroImage = await getHeroImage();
  return <main><HomeClient initialHeroImage={heroImage} /><JsonLd data={websiteSchema} /></main>;
}
