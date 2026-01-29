"use client";

import { motion } from "framer-motion";
import { Heart } from "lucide-react";
import Image from "next/image";
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
      w-14 h-14
      rounded-full
      overflow-hidden
      shadow-sm
    "
              >
                <Image
                  src="/LogoSoul.PNG"
                  alt="Soul Logo"
                  fill
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
                href="tel:0507456258"
                className="hover:text-foreground transition-colors"
              >
                0507456258
              </a>
            </div>
          </motion.div>
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
          <p className="text-sm text-muted-foreground ">
            تم التطوير بواسطة{" "}
            <a href="https://www.instagram.com/rizikdhabre1/">Rizik Dhabre</a>
          </p>
        </motion.div>
      </div>
    </footer>
  );
};

export default Footer;
