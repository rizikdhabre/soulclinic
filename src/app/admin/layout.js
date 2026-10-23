import AdminLayoutClient from "./AdminLayoutClient";
import { privateMetadata } from "@/lib/seo/metadata";
export const metadata = privateMetadata;
export default function AdminLayout({ children }) { return <AdminLayoutClient>{children}</AdminLayoutClient>; }
