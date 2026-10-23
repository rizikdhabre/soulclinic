"use client";

import { motion } from "framer-motion";
import { Heart } from "lucide-react";
import Image from "next/image";
import Link from "next/link";
import { business } from "@/lib/seo/business";
const Footer = () => {
  return (
    <footer className="bg-card border-t border-border">
      <div className="container mx-auto px-6 py-16">
        <div className="grid md:grid-cols-3 gap-12 md:gap-8">
          {/* Brand */}
          <motion.div
            initial={{ opacity: 0, y: 20 }}
            whileInView={{ opacity: 1, y: 0 }}
            viewport={{ once: true }}
            transition={{ duration: 0.5 }}
          >
            <div className="flex items-center gap-3 mb-4">
              <div
                className="
      relative
      w-20 h-20
      rounded-full
      overflow-hidden
      shadow-sm
    "
              >
                <Image
                  src="/logo.PNG"
                  alt="Soul Logo"
                  fill
                  sizes="80px"
                  className="object-contain rounded-full"
                />
              </div>

              <span className="font-serif text-2xl text-foreground">Soul</span>
            </div>
            <p className="text-subtle max-w-xs">
              استعادة التوازن، وشفاء الجسد، وتهدئة الروح
            </p>
          </motion.div>

          {/* Contact Info */}
          <motion.div
            initial={{ opacity: 0, y: 20 }}
            whileInView={{ opacity: 1, y: 0 }}
            viewport={{ once: true }}
            transition={{ duration: 0.5, delay: 0.2 }}
          >
            <h4 className="font-serif text-lg text-foreground mb-4">
              اتصل بنا
            </h4>
            <div className="space-y-2 text-muted-foreground">
              <p>ديرحنا</p>

              <a
                href={`tel:${business.phone}`}
                className="hover:text-foreground transition-colors"
              >
                <bdi>{business.displayPhone}</bdi>
              </a>
            </div>
          </motion.div>
          <nav aria-label="روابط العيادة" className="text-sm text-muted-foreground">
            <h4 className="font-serif text-xl text-foreground mb-4">عيادة SOUL في دير حنا</h4>
            <ul className="space-y-2">
              <li><Link href="/dashboard" className="hover:text-foreground transition-colors">تصفّح العلاجات والأسعار</Link></li>
              <li><Link href="/about" className="hover:text-foreground transition-colors">تعرّف على عيادة SOUL</Link></li>
              <li><Link href="/contact" className="hover:text-foreground transition-colors">موقع العيادة والتواصل</Link></li>
            </ul>
          </nav>
        </div>

        {/* Bottom Bar */}
        <motion.div
          initial={{ opacity: 0 }}
          whileInView={{ opacity: 1 }}
          viewport={{ once: true }}
          transition={{ duration: 0.5, delay: 0.3 }}
          className="mt-12 pt-8 border-t border-border flex flex-col md:flex-row items-center justify-between gap-4"
        >
          <p className="text-sm text-muted-foreground">
            © {new Date().getFullYear()} Soul. جميع الحقوق محفوظة.
          </p>

          <p className="text-sm text-muted-foreground flex items-center gap-1">
            صُنع بـ <Heart className="w-4 h-4 text-accent fill-accent" /> من أجل
            صحتك ورفاهيتك
          </p>
          <p className="text-sm text-muted-foreground">
            تم التطوير بواسطة{" "}
            <a
              href="https://www.instagram.com/rizikdhabre1/"
              target="_blank"
              rel="noopener noreferrer"
              className="
                    inline-flex
                    items-center
                    gap-1
                    px-3
                    py-1
                    rounded-full
                    border
                    border-primary/30
                    text-primary
                    font-medium
                    transition-all
                    duration-300
                    hover:bg-primary
                    hover:text-primary-foreground
                    hover:shadow-lg
                    hover:scale-105
                    focus:outline-none
                    focus:ring-2
                    focus:ring-primary/40
                  "
            >
              Rizik Dhabre
            </a>
          </p>
        </motion.div>
      </div>
    </footer>
  );
};

export default Footer;
