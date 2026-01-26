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
            <h1 className="heading-display text-foreground mb-6">
              Our Treatments
            </h1>
            <p className="text-body text-muted-foreground">
              Discover our carefully curated collection of therapies, each
              designed to nurture your wellbeing and restore your natural
              balance.
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
