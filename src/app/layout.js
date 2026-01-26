import "./globals.css";
import { Geist, Geist_Mono } from "next/font/google";
import Header from "@/components/Header/page";
import Footer from "@/components/Footer/page";
import ContactButtons from "@/components/contactButtons/ContactButtons";
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
  title: "SoulClinc",
  description: "not now",
};

export default function RootLayout({ children }) {
  return (
    <html lang="ar" dir="rtl"> 
      <body
        className={`${geistSans.variable} ${geistMono.variable} antialiased`}
      >
        <Header/>
        {children}
        <ContactButtons />
         <Toaster richColors position="top-right" />
        <Footer/>
      </body>
    </html>
  );
}
