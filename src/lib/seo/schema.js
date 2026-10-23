import { absoluteUrl, business } from "./business";
import { treatmentPath } from "../catalogue/model";
export const serializeJsonLd = (value) => JSON.stringify(value).replace(/</g, "\\u003c").replace(/\u2028/g, "\\u2028").replace(/\u2029/g, "\\u2029");
export const businessSchema = {
  "@type": "LocalBusiness", "@id": absoluteUrl("/#business"), name: business.name,
  alternateName: business.alternateNames, url: business.origin, logo: absoluteUrl(business.logo),
  image: absoluteUrl(business.logo), telephone: business.phone,
  address: { "@type": "PostalAddress", addressLocality: business.locality, addressCountry: "IL" },
};
export const websiteSchema = {
  "@type": "WebSite", "@id": absoluteUrl("/#website"), name: business.name,
  alternateName: business.alternateNames, url: business.origin, inLanguage: "ar",
  publisher: { "@id": absoluteUrl("/#business") },
};
export function breadcrumbs(items) {
  return { "@type": "BreadcrumbList", itemListElement: items.map(([name, path], i) => ({ "@type": "ListItem", position: i + 1, name, item: absoluteUrl(path) })) };
}
export function treatmentSchema(record) {
  const url = absoluteUrl(treatmentPath(record));
  return {
    "@type": "Service", "@id": url + "#service", name: record.title, description: record.description,
    url, provider: { "@id": absoluteUrl("/#business") },
    hasOfferCatalog: { "@type": "OfferCatalog", name: record.title, itemListElement: record.services.map((s) => ({
      "@type": "Offer", name: s.title, url,
      ...(s.price !== "" && s.price != null && Number.isFinite(Number(s.price)) && Number(s.price) >= 0 && /^[A-Z]{3}$/.test(s.currency || "") ? { price: Number(s.price), priceCurrency: s.currency } : {}),
      itemOffered: { "@type": "Service", name: s.title, description: s.description },
    })) },
  };
}
