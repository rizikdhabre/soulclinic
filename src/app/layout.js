import "./globals.css";
import { Geist, Geist_Mono } from "next/font/google";
import Header from "@/components/Header/page";
import Footer from "@/components/Footer/page";
import ContactButtonsWrapper from "@/components/contactButtons/ContactButtonsWrapper";
import { Toaster } from "sonner";
import { business } from "@/lib/seo/business";
import { businessSchema } from "@/lib/seo/schema";
import JsonLd from "@/components/seo/JsonLd";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata = {
  metadataBase: new URL(business.origin),
  title: { default: business.name, template: `%s | ${business.name}` },
  icons: { icon: "/favicon.ico", apple: "/logo.PNG" },
  referrer: "strict-origin",
  robots: { index: process.env.VERCEL_ENV !== "preview" && process.env.SITE_NOINDEX !== "true", follow: true },
};

export default function RootLayout({ children }) {
  return (
    <html lang="ar" dir="rtl">
      <body
        className={`${geistSans.variable} ${geistMono.variable} antialiased`}
      >
        <JsonLd data={businessSchema} />
        <Header />
        {children}
        <ContactButtonsWrapper />
        <Toaster richColors position="top-right" />
        <Footer />
      </body>
    </html>
  );
}
