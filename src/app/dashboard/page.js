"use client";

import { useEffect, useState } from "react";
import { motion } from "framer-motion";
import TreatmentCard from "@/components/TreatmentCard/page";
import NeonLoader from "@/components/ui/loading";

const Dashboard = () => {
  const [treatments, setTreatments] = useState([]);
  const [loading, setLoading] = useState(false);
  const [loaderSize, setLoaderSize] = useState({ w: 260, h: 70 });
  const getLoaderSize = () => {
    if (typeof window === "undefined") return { w: 260, h: 70 };

    useEffect(() => {
      setLoaderSize(getLoaderSize());

      const onResize = () => setLoaderSize(getLoaderSize());
      window.addEventListener("resize", onResize);
      return () => window.removeEventListener("resize", onResize);
    }, []);
    const width = window.innerWidth;
    if (width < 640) return { w: 220, h: 60 };
    if (width < 1024) return { w: 280, h: 70 };
    return { w: 360, h: 80 };
  };

  useEffect(() => {
    const fetchTreatments = async () => {
      try {
        setLoading(true);

        const res = await fetch("/api/admin/treatments", {
          cache: "no-store",
        });

        const data = await res.json();
        setTreatments(data);
      } catch (err) {
        console.error(err);
      } finally {
        setLoading(false);
      }
    };

    fetchTreatments();
  }, []);
  if (loading) {
    return (
      <div className="min-h-screen flex flex-col items-center justify-center gap-6">
        <NeonLoader width={loaderSize.w} height={loaderSize.h} />

        <p className="text-muted-foreground text-lg">جاري تحميل العلاجات...</p>
      </div>
    );
  }
  return (
    <div className="min-h-screen pt-24">
      <section className="py-20 wellness-gradient">
        <div className="container mx-auto px-6">
          <motion.div
            initial={{ opacity: 0, y: 30 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.7 }}
            className="max-w-3xl mx-auto text-center"
          >
            <h1 className="heading-display text-foreground mb-6">علاجاتنا</h1>
            <p className="text-body text-muted-foreground">
              نقدّم مجموعة من العلاجات المتخصصة التي تهدف إلى تخفيف الألم، تحسين
              صحة الجسم، واستعادة التوازن الجسدي والنفسي، وذلك باستخدام أساليب
              علاجية آمنة وفعّالة تُقدَّم باحترافية واهتمام بكل شخص.
            </p>
          </motion.div>
        </div>
      </section>

      <section className="py-24 bg-background">
        <div className="container mx-auto px-6">
          <div className="grid md:grid-cols-2 lg:grid-cols-3 gap-8">
            {treatments.map((t, index) => (
              <TreatmentCard
                key={t._id}
                id={t._id}
                title={t.title}
                description={t.description}
                index={index}
              />
            ))}
          </div>
        </div>
      </section>
    </div>
  );
};

export default Dashboard;
