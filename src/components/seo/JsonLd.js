import { serializeJsonLd } from "@/lib/seo/schema";
export default function JsonLd({ data }) {
  return <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: serializeJsonLd({ "@context": "https://schema.org", "@graph": Array.isArray(data) ? data : [data] }) }} />;
}
