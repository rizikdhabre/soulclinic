import "./globals.css";
import { Geist, Geist_Mono } from "next/font/google";
import Header from "@/components/Header/page";
import Footer from "@/components/Footer/page";
import ContactButtonsWrapper from "@/components/contactButtons/ContactButtonsWrapper";
import { Toaster } from "sonner";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata = {
  metadataBase: new URL("https://soulclinc.net"),

  title: {
    default: "عيادة SOUL | استعادة التوازن وشفاء الجسد",
    template: "%s | SoulClinc",
  },

  description:
    "عيادة SOUL تقدم علاجات طبيعية متخصصة مثل الحجامة، الإبر الصينية، المساج الطبي والعلاجات الشمولية لاستعادة التوازن الجسدي والنفسي.",

  keywords: [
    "عيادة سول",
    "علاجات طبيعية",
    "حجامة",
    "إبر صينية",
    "مساج طبي",
    "علاج بالطاقة",
    "دير حنا",
    "SoulClinc",
    "Natural Healing",
    "Cupping Therapy",
    "Acupuncture",
    "Medical Massage",
    "Holistic Wellness",
  ],

  alternates: {
    canonical: "/",
  },

  icons: {
    icon: "/favicon.ico",
  },

  openGraph: {
    title: "عيادة SOUL | استعادة التوازن وشفاء الجسد",
    description:
      "علاجات طبيعية تشمل الحجامة، الإبر الصينية، المساج الطبي والعلاج الشمولي.",
    url: "https://soulclinc.net",
    siteName: "SoulClinc",
    locale: "ar_AR",
    type: "website",
  },

  twitter: {
    card: "summary",
    title: "عيادة SOUL",
    description: "علاجات طبيعية متخصصة لاستعادة التوازن الجسدي والنفسي.",
  },

  robots: {
    index: true,
    follow: true,
  },
};

export default function RootLayout({ children }) {
  return (
    <html lang="ar" dir="rtl">
      <body
        className={`${geistSans.variable} ${geistMono.variable} antialiased`}
      >
        <script
          type="application/ld+json"
          dangerouslySetInnerHTML={{
            __html: JSON.stringify({
              "@context": "https://schema.org",
              "@type": "Organization",
              name: "SoulClinc",
              url: "https://soulclinc.net",
              logo: "https://soulclinc.net/logo.png",
            }),
          }}
        />
        <Header />
        {children}
        <ContactButtonsWrapper />
        <Toaster richColors position="top-right" />
        <Footer />
      </body>
    </html>
  );
}
