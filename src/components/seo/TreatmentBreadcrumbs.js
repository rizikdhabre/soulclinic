import Link from "next/link";
import { breadcrumbs } from "@/lib/seo/schema";
import { treatmentPath } from "@/lib/catalogue/model";
import JsonLd from "./JsonLd";

export default function TreatmentBreadcrumbs({ treatment }) {
  const items = [["الرئيسية", "/"], ["العلاجات والأسعار", "/dashboard"], [treatment.title, treatmentPath(treatment)]];
  return (
    <>
      <nav aria-label="مسار التنقل" className="mb-4 text-sm text-muted-foreground">
        <ol className="flex flex-wrap items-center gap-2">
          {items.map(([name, path], index) => (
            <li key={path} className="flex items-center gap-2 min-w-0">
              {index > 0 && <span aria-hidden="true">/</span>}
              {index === items.length - 1
                ? <span aria-current="page" className="break-words">{name}</span>
                : <Link href={path} className="hover:text-foreground transition-colors">{name}</Link>}
            </li>
          ))}
        </ol>
      </nav>
      <JsonLd data={breadcrumbs(items)} />
    </>
  );
}
