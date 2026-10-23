import { business } from "@/lib/seo/business";
export default function robots() {
  const preview = process.env.VERCEL_ENV === "preview" || process.env.SITE_NOINDEX === "true";
  return { rules: { userAgent: "*", ...(preview ? { disallow: "/" } : { allow: "/" }) }, sitemap: `${business.origin}/sitemap.xml` };
}
