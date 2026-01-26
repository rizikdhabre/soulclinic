"use client";

import { motion } from "framer-motion";
import { useRouter } from "next/navigation";

const TreatmentCard = ({ id, title, description, index }) => {
  const router = useRouter();

  return (
    <motion.div
      initial={{ opacity: 0, y: 30 }}
      whileInView={{ opacity: 1, y: 0 }}
      viewport={{ once: true, margin: "-50px" }}
      transition={{ duration: 0.5, delay: index * 0.1 }}
      whileHover={{ y: -8, scale: 1.02 }}
      onClick={() => router.push(`/treatments/${id}`)}
      className="group glass-card p-8 cursor-pointer transition-all duration-500 hover:shadow-elevated"
    >
      {/* Title */}
      <h3 className="font-serif text-2xl md:text-3xl text-foreground mb-3 group-hover:text-primary transition-colors duration-300">
        {title}
      </h3>

      {/* Description */}
      <p className="text-subtle leading-relaxed">
        {description}
      </p>

      {/* Decorative Line */}
      <motion.div
        initial={{ scaleX: 0 }}
        whileInView={{ scaleX: 1 }}
        viewport={{ once: true }}
        transition={{ duration: 0.6, delay: 0.3 + index * 0.1 }}
        className="h-0.5 bg-gradient-to-r from-primary/30 via-accent/50 to-transparent mt-6 origin-left"
      />
    </motion.div>
  );
};

export default TreatmentCard;
