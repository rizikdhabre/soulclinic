import About from "./AboutClient";
import { pageMetadata } from "@/lib/seo/metadata";
export const metadata = pageMetadata({ title: "عن عيادة SOUL في دير حنا", description: "تعرّف على عيادة SOUL وخيارات الجلسات في دير حنا، ومعلومات تساعدك على الاستفسار عن الخدمة ومقدم الجلسة قبل الحجز.", path: "/about" });
export default function AboutPage() { return <main><About /></main>; }
