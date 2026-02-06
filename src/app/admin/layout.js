"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { motion, AnimatePresence } from "framer-motion";
import { useState } from "react";
import { Menu, X } from "lucide-react";

const navItems = [
  { label: "الرئيسية", href: "/admin" },
  { label: "الملف الشخصي", href: "/admin/profile" },
  { label: "العلاجات", href: "/admin/treatments" },
  { label: "المستخدمون", href: "/admin/users" },
];

export default function AdminLayout({ children }) {
  const pathname = usePathname();
  const [open, setOpen] = useState(false);
  const [collapsed, setCollapsed] = useState(false);

  const SidebarContent = () => (
    <>
      <h2 className="text-lg font-bold mb-6 text-center">لوحة التحكم</h2>

      <nav className="flex flex-col gap-2">
        {navItems.map((item) => {
          const active = pathname === item.href;

          return (
            <Link
              key={item.href}
              href={item.href}
              onClick={() => setOpen(false)}
              className={`
                px-4 py-3 rounded-lg text-sm font-medium transition
                ${active ? "bg-primary text-white shadow" : "hover:bg-muted"}
              `}
            >
              {item.label}
            </Link>
          );
        })}
      </nav>
    </>
  );

  return (
    <div className="pt-32 min-h-screen">
 {/* Floating Admin Toggle – Mobile */}
<div className="fixed md:hidden z-40 right-0 top-32 flex items-center">
  {/* ARROW – ALWAYS VISIBLE */}
  <button
    onClick={() => setCollapsed((c) => !c)}
    className="
      bg-background border border-r-0
      rounded-l-lg
      px-2 py-3
      shadow-md
      z-50
    "
  >
    {collapsed ? "◀" : "▶"}
  </button>

  {/* SLIDING BUTTON – ONLY THIS MOVES */}
  <div
    className={`
      transition-transform duration-300
      ${collapsed ? "translate-x-full" : "translate-x-0"}
    `}
  >
    <button
      onClick={() => setOpen(true)}
      className="
        flex items-center gap-2
        px-4 py-3
        bg-background border
        rounded-r-lg
        shadow-md
        whitespace-nowrap
      "
    >
      ☰ قائمة الإدارة
    </button>
  </div>
</div>


      <div className="flex">
        <aside className="hidden md:block w-64 border-l bg-background px-4 py-6">
          <SidebarContent />
        </aside>
        <AnimatePresence>
          {open && (
            <>
              <motion.div
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                className="fixed inset-0 z-40 bg-black/40"
                onClick={() => setOpen(false)}
              />
              <motion.aside
                initial={{ x: "100%" }}
                animate={{ x: 0 }}
                exit={{ x: "100%" }}
                transition={{ type: "spring", stiffness: 260, damping: 25 }}
                className="
                  fixed top-32 right-0 z-50
                  w-72 h-[calc(100vh-8rem)]
                  bg-background border-l px-4 py-6
                "
              >
                <div className="flex justify-between items-center mb-6">
                  <h2 className="font-bold">لوحة التحكم</h2>
                  <button onClick={() => setOpen(false)}>
                    <X className="w-5 h-5" />
                  </button>
                </div>

                <SidebarContent />
              </motion.aside>
            </>
          )}
        </AnimatePresence>
        <main className="flex-1 px-6 py-6 bg-muted/30">{children}</main>
      </div>
    </div>
  );
}
