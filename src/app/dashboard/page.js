"use client";

import { useEffect, useState } from "react";
import { motion } from "framer-motion";
import TreatmentCard from "@/components/TreatmentCard/page";

const Dashboard = () => {
  const [treatments, setTreatments] = useState([]);

  useEffect(() => {
    const fetchTreatments = async () => {
      const res = await fetch("api/admin/treatments", {
        cache: "no-store",
      });
      const data = await res.json();
      setTreatments(data);
    };

    fetchTreatments();
  }, []);

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
