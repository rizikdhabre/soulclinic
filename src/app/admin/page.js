"use client";

import Link from "next/link";
import { motion } from "framer-motion";
import { useRouter } from "next/navigation";
import axios from "axios";

const adminSections = [
  { title: "Treatments", href: "/admin/treatments" },
  { title: "Users", href: "/admin/users" },
  { title: "Profile", href: "/admin/profile" },
];

const containerVariants = {
  hidden: { opacity: 0 },
  visible: {
    opacity: 1,
    transition: { staggerChildren: 0.12 },
  },
};

const cardVariants = {
  hidden: { opacity: 0, y: 30 },
  visible: {
    opacity: 1,
    y: 0,
    transition: { duration: 0.5, ease: "easeOut" },
  },
};

export default function AdminPage() {
  const router = useRouter();

  const handleLogout = async () => {
    await axios.post("/api/logoutAdmin");
    router.replace("/");
  };

  return (
    <div className="min-h-[calc(100vh-160px)] flex items-center justify-center pt-10">
      <motion.div
        variants={containerVariants}
        initial="hidden"
        animate="visible"
        className="w-full max-w-3xl px-6"
      >
        {/* Title */}
        <motion.h1
          initial={{ opacity: 0, y: -20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.5 }}
          className="text-4xl font-bold text-center mb-4"
        >
          Admin Panel
        </motion.h1>

        {/* Logout panel */}
        <motion.div
          initial={{ opacity: 0, y: -10 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.15 }}
          className="flex justify-center mb-10"
        >
          <button
            onClick={handleLogout}
            className="
              px-6 py-2 rounded-full text-sm font-medium
              border border-destructive text-destructive
              hover:bg-destructive hover:text-white
              transition
            "
          >
            Logout
          </button>
        </motion.div>

        {/* Cards */}
        <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
          {adminSections.map((s) => (
            <motion.div
              key={s.title}
              variants={cardVariants}
              whileHover={{ y: -8, scale: 1.02 }}
              whileTap={{ scale: 0.98 }}
            >
              <Link
                href={s.href}
                className="
                  block rounded-2xl border p-10 text-center
                  transition-all duration-300
                  hover:shadow-xl hover:border-primary
                  bg-background
                "
              >
                <h2 className="text-2xl font-semibold">{s.title}</h2>
              </Link>
            </motion.div>
          ))}
        </div>
      </motion.div>
    </div>
  );
}
