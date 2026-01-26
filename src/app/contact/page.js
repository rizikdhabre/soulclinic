"use client";

import { motion } from "framer-motion";
import { MapPin, Phone } from "lucide-react";
import { FaWhatsapp, FaInstagram } from "react-icons/fa";

const contactItems = [
  {
    icon: MapPin,
    title: "الموقع",
    content: ["شارع القدس", "دير حنا"],
    href: "https://www.google.com/maps/search/?api=1&query=32.8612376,35.36135",
  },
  {
    icon: Phone,
    title: "الهاتف",
    content: ["+972 53-2286019", "السبت – الاثنين: 9:00 - 20:00"],
    href: "tel:+972532286019",
  },
];

const WHATSAPP_URL = "https://wa.me/972507456258";
const INSTAGRAM_URL = "https://www.instagram.com/soul_clinica/";

const Contact = () => {
  return (
    <div className="min-h-screen pt-24" dir="rtl">
      <section className="py-24 bg-background">
        <div className="container mx-auto px-6">
          <div className="grid lg:grid-cols-2 gap-16">
            {/* Contact Info */}
            <motion.div
              initial={{ opacity: 0, x: 30 }}
              whileInView={{ opacity: 1, x: 0 }}
              viewport={{ once: true }}
              transition={{ duration: 0.6 }}
              className="space-y-8 text-right"
            >
              <h2 className="heading-section text-foreground mb-6">
                زورونا
              </h2>

              <p className="text-body text-muted-foreground leading-relaxed">
                نرحّب بكم لزيارتنا والتعرّف على خدماتنا عن قرب، حيث نوفّر لكم
                بيئة هادئة ورعاية مهنية تهدف إلى راحتكم وشفائكم.
              </p>

              {/* Contact Cards */}
              {contactItems.map((item) => (
                <a
                  key={item.title}
                  href={item.href}
                  target={item.title === "الموقع" ? "_blank" : undefined}
                  rel="noopener noreferrer"
                  className="block"
                >
                  <motion.div
                    whileHover={{ y: -4, scale: 1.02 }}
                    className="glass-card p-6 flex flex-row-reverse gap-4 cursor-pointer transition-all duration-300 hover:shadow-xl"
                  >
                    {/* Icon */}
                    <div className="w-12 h-12 rounded-xl bg-primary/10 flex items-center justify-center shrink-0">
                      <item.icon className="w-6 h-6 text-primary" />
                    </div>

                    {/* Text */}
                    <div>
                      <h3 className="font-serif text-lg text-foreground">
                        {item.title}
                      </h3>
                      {item.content.map((line, i) => (
                        <p key={i} className="text-muted-foreground">
                          {line}
                        </p>
                      ))}
                    </div>
                  </motion.div>
                </a>
              ))}

              {/* Social Buttons */}
              <div className="pt-4 flex justify-center gap-4">
                <motion.a
                  href={INSTAGRAM_URL}
                  target="_blank"
                  rel="noopener noreferrer"
                  aria-label="Instagram"
                  whileHover={{ scale: 1.1 }}
                  whileTap={{ scale: 0.95 }}
                  className="bg-gradient-to-tr from-yellow-400 via-pink-500 to-purple-600 text-white rounded-full p-3 shadow-lg flex items-center justify-center hover:opacity-90 transition"
                >
                  <FaInstagram size={20} />
                </motion.a>

                <motion.a
                  href={WHATSAPP_URL}
                  target="_blank"
                  rel="noopener noreferrer"
                  aria-label="WhatsApp"
                  whileHover={{ scale: 1.1 }}
                  whileTap={{ scale: 0.95 }}
                  className="bg-green-500 hover:bg-green-600 text-white rounded-full p-3 shadow-lg flex items-center justify-center transition"
                >
                  <FaWhatsapp size={20} />
                </motion.a>
              </div>

              {/* Map */}
              <div className="aspect-[16/9] rounded-2xl overflow-hidden border border-border shadow-sm">
                <iframe
                  src="https://www.google.com/maps/embed?pb=!1m18!1m12!1m3!1d3351.3961089105705!2d35.361349975463476!3d32.86123757362853!2m3!1f0!2f0!3f0!3m2!1i1024!2i768!4f13.1!3m3!1m2!1s0x151c37002ffa1b4f%3A0xf8e9e372a89e34c7!2sSoul!5e0!3m2!1sar!2sil!4v1768973816043"
                  className="w-full h-full"
                  loading="lazy"
                  referrerPolicy="no-referrer-when-downgrade"
                  allowFullScreen
                />
              </div>
            </motion.div>
          </div>
        </div>
      </section>
    </div>
  );
};

export default Contact;
