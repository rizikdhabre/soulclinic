import { absoluteUrl, business } from "./business";
export const privateMetadata = { robots: { index: false, follow: false }, referrer: "no-referrer" };
export function pageMetadata({ title, description, path, image, indexable = true }) {
  const fullTitle = `${title} | ${business.name}`;
  const url = absoluteUrl(path);
  const images = [{ url: absoluteUrl(image || "/opengraph-image"), alt: title }];
  const production = process.env.VERCEL_ENV !== "preview" && process.env.SITE_NOINDEX !== "true";
  return {
    title: { absolute: fullTitle }, description, alternates: { canonical: url },
    robots: { index: indexable && production, follow: true },
    openGraph: { title: fullTitle, description, url, siteName: business.name, locale: "ar_IL", type: "website", images },
    twitter: { card: "summary_large_image", title: fullTitle, description, images: images.map((item) => item.url) },
  };
}
