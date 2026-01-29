"use client";

import { usePathname } from "next/navigation";
import ContactButtons from "@/components/contactButtons/ContactButtons";

export default function ContactButtonsWrapper() {
  const pathname = usePathname();
  if (pathname.startsWith("/admin")) return null;

  return <ContactButtons />;
}
