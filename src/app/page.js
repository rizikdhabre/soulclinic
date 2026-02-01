"use client";

import { motion } from "framer-motion";
import { ArrowLeft, Sparkles, Leaf, Heart } from "lucide-react";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import Image from "next/image";
import ParticleSphere from "@/components/ui/ParticleSphere";
import axios from "axios";
import { useEffect, useState } from "react";
import NeonLoader from "@/components/ui/loading";

const HomePage = () => {
  const [loadingImg, setLoadingImg] = useState(true);
  const [heroImage, setHeroImage] = useState(null);
  const [gregorianDate, setGregorianDate] = useState("");
  const [hijriDate, setHijriDate] = useState("");

  useEffect(() => {
    const today = new Date();
    const gregorian = today.toLocaleDateString("en-GB");
    const hijri = new Intl.DateTimeFormat("ar-SA-u-ca-islamic-nu-latn", {
      day: "numeric",
      month: "long",
      year: "numeric",
    }).format(today);

    setGregorianDate(`${gregorian} ميلادي`);
    setHijriDate(`${hijri} `);
  }, []);
  useEffect(() => {
    const fetchHeroImage = async () => {
      try {
        const res = await axios.get("/api/admin/upload-hero-image");
        if (res.data?.heroImageUrl) {
          setHeroImage(res.data.heroImageUrl);
        }
      } catch (err) {
        console.error("Failed to fetch hero image", err);
      }
    };

    fetchHeroImage();
  }, []);

  return (
    <div className="min-h-screen">
      {/* Hero Section */}
      <section className="relative min-h-screen flex items-center justify-center overflow-hidden wellness-gradient">
        {/* Floating Elements */}
        <motion.div
          animate={{ y: [-10, 10, -10] }}
          transition={{ duration: 6, repeat: Infinity, ease: "easeInOut" }}
          className="absolute top-1/4 left-[10%] w-24 h-24 rounded-full bg-primary/10 blur-2xl"
        />
        <motion.div
          animate={{ y: [10, -10, 10] }}
          transition={{ duration: 8, repeat: Infinity, ease: "easeInOut" }}
          className="absolute bottom-1/3 right-[15%] w-32 h-32 rounded-full bg-accent/20 blur-2xl"
        />
        <motion.div
          animate={{ y: [-5, 15, -5] }}
          transition={{ duration: 7, repeat: Infinity, ease: "easeInOut" }}
          className="absolute top-1/3 right-[30%] w-16 h-16 rounded-full bg-primary/15 blur-xl"
        />

        <div className="container mx-auto px-6 pb-12 relative z-10">
          <div className="max-w-4xl mx-auto text-center">
            <motion.div
              initial={{ opacity: 0, y: -12 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.6 }}
              className="w-full relative mb-10"
            >
              <div className="relative w-full h-[45vh] md:h-[70vh] overflow-hidden">
                {/* Loader */}
                {(loadingImg || !heroImage) && (
                  <div className="absolute inset-0 z-10 flex flex-col items-center justify-center bg-background/70 backdrop-blur-sm transition-opacity duration-500">
                    <NeonLoader width={260} height={70} />
                    <p className="mt-4 text-muted-foreground text-lg animate-pulse">
                      جاري تحميل الصورة...
                    </p>
                  </div>
                )}

                {/* Image */}
                {heroImage && (
                  <Image
                    src={heroImage}
                    alt="SoulClinic Hero"
                    fill
                    priority
                    sizes="100vw"
                    className={`object-cover transition-opacity duration-700 ${
                      loadingImg ? "opacity-0" : "opacity-100"
                    }`}
                    onLoadingComplete={() => setLoadingImg(false)}
                  />
                )}
              </div>
            </motion.div>
            <div className="h-20 bg-gradient-to-b from-transparent to-background -mt-20" />
            <motion.h1
              initial={{ opacity: 0, y: 30 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.7, delay: 0.1 }}
              className="heading-display text-foreground mb-6"
            >
              اكتشف طريقك إلى{" "}
              <span className="text-primary">السلام الداخلي</span>
            </motion.h1>

            {/* CTA Buttons */}
            <motion.div
              initial={{ opacity: 0, y: 30 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.7, delay: 0.3 }}
              className="flex flex-col sm:flex-row items-center justify-center gap-4"
            >
              <Button
                asChild
                size="xl"
                className="group px-12 py-8 rounded-full text-4xl"
              >
                <Link
                  href="/dashboard"
                  className="font-semibold flex items-center"
                >
                  احجز موعدك الآن
                  <ArrowLeft className="ml-7 w-10 h-10 group-hover:translate-x-1 transition-transform" />
                </Link>
              </Button>
            </motion.div>
          </div>
              <p className="text-s text-center tracking-widest text-muted-foreground mt-5">
      اليوم
    </p>
          <div className="mt-2 text-center">
            <p className="text-sm md:text-base text-muted-foreground tracking-wide">
              {gregorianDate}
            </p>
            <p className="text-sm md:text-base text-muted-foreground tracking-wide">
              {hijriDate}
            </p>
          </div>
        </div>

        {/* Scroll Indicator */}
        {/* <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ delay: 1 }}
          className="absolute bottom-8 left-1/2 -translate-x-1/2"
        >
          <motion.div
            animate={{ y: [0, 8, 0] }}
            transition={{ duration: 1.5, repeat: Infinity }}
            className="w-6 h-10 rounded-full border-2 border-foreground/30 flex items-start justify-center p-2"
          >
            <motion.div className="w-1 h-2 rounded-full bg-foreground/50" />
          </motion.div>
        </motion.div> */}
      </section>

      {/* <motion.div
        initial={{ opacity: 0, y: 30 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ delay: 0.8 }}
        className="py-24 flex justify-center"
      >
        <ParticleSphere size={160} enableZoom={false} autoRotate={false} />
      </motion.div> */}

      {/* Features Section */}
      <section className="py-24 bg-background">
        <div className="container mx-auto px-6">
          <motion.div
            initial={{ opacity: 0, y: 30 }}
            whileInView={{ opacity: 1, y: 0 }}
            viewport={{ once: true }}
            transition={{ duration: 0.6 }}
            className="text-center mb-16"
          >
            <h2 className="heading-section text-foreground mb-4">
              لماذا تختار عيادة SOUL؟
            </h2>
          </motion.div>
          <div className="grid md:grid-cols-3 gap-8">
            {[
              {
                icon: Leaf,
                title: "العلاجات الطبيعية",
                description:
                  "جميع العلاجات تستخدم مكونات عضوية ومصدرها مستدام لتحقيق شفاء نقي.",
              },
              {
                icon: Heart,
                title: "أخصائيين مختصين",
                description:
                  "يقدّم ممارسونا المعتمدون سنواتٍ من الخبرة والرعاية الصادق",
              },
              {
                icon: Sparkles,
                title: "نتائج مُغيِّرة للحياة",
                description:
                  "اختبر فوائد دائمة تمتد إلى ما هو أبعد بكثير من زيارتك",
              },
            ].map((feature, index) => (
              <motion.div
                key={feature.title}
                initial={{ opacity: 0, y: 30 }}
                whileInView={{ opacity: 1, y: 0 }}
                viewport={{ once: true }}
                transition={{ duration: 0.5, delay: index * 0.1 }}
                className="glass-card p-8 text-center hover:shadow-elevated transition-shadow"
              >
                <div className="w-14 h-14 rounded-2xl bg-primary/10 flex items-center justify-center mx-auto mb-6">
                  <feature.icon className="w-7 h-7 text-primary" />
                </div>
                <h3 className="font-serif text-2xl text-foreground mb-3">
                  {feature.title}
                </h3>
                <p className="text-subtle">{feature.description}</p>
              </motion.div>
            ))}
          </div>
        </div>
      </section>
    </div>
  );
};

export default HomePage;
