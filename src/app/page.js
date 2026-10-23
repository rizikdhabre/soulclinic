import HomeClient from "@/components/home/HomeClient";
import { getHeroImage, getPublicTreatments } from "@/lib/catalogue/public";
import { treatmentPath } from "@/lib/catalogue/model";
import Link from "next/link";
import { pageMetadata } from "@/lib/seo/metadata";
import { websiteSchema } from "@/lib/seo/schema";
import JsonLd from "@/components/seo/JsonLd";
export const dynamic = "force-dynamic";
export const metadata = pageMetadata({ title: "عيادة SOUL للحجامة والمساج والإبر الصينية في دير حنا", description: "عيادة SOUL في دير حنا: اكتشف جلسات الحجامة والمساج والإبر الصينية وخيارات العناية، مع تفاصيل الأسعار والمدة وحجز المواعيد.", path: "/" });
export default async function Home() {
  const heroImage = await getHeroImage();
  const treatments = (await getPublicTreatments()).filter((t) => t.indexable).slice(0, 3);
  return (
    <main>
      <HomeClient initialHeroImage={heroImage}>
        {treatments.length > 0 && (
          <nav aria-label="استكشف علاجات العيادة" className="mt-8 text-sm text-muted-foreground">
            <ul className="flex flex-wrap justify-center gap-x-6 gap-y-3">
              {treatments.map((t) => <li key={t._id}><Link href={treatmentPath(t)} className="hover:text-foreground underline underline-offset-4">{t.title} في دير حنا</Link></li>)}
              <li><Link href="/dashboard" className="hover:text-foreground underline underline-offset-4">جميع العلاجات والأسعار</Link></li>
            </ul>
          </nav>
        )}
      </HomeClient>
      <JsonLd data={websiteSchema} />
    </main>
  );
}
