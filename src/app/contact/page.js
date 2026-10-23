import Contact from "./ContactClient";
import { pageMetadata } from "@/lib/seo/metadata";
export const metadata = pageMetadata({ title: "موقع عيادة SOUL والتواصل في دير حنا", description: "عنوان عيادة SOUL في شارع القدس، دير حنا. اتصل على 0532286019 أو تواصل عبر واتساب للاستفسار وتأكيد موعد زيارتك.", path: "/contact" });
export default function ContactPage() { return <main><Contact /></main>; }
