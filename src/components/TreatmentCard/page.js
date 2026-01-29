"use client";

import { motion } from "framer-motion";
import { useRouter } from "next/navigation";
import ForwardBackButton from "../ui/ForwardBackButton";

const TreatmentCard = ({ id, title, description, index }) => {
  const router = useRouter();

  const goToTreatment = () => {
    router.push(`/treatments/${id}`);
  };

  return (
    <motion.div
      initial={{ opacity: 0, y: 30 }}
      whileInView={{ opacity: 1, y: 0 }}
      viewport={{ once: true, margin: "-50px" }}
      transition={{ duration: 0.5, delay: index * 0.1 }}
      whileHover={{ y: -6 }}
      onClick={goToTreatment}
      className="
        relative
        group
        glass-card
        p-7
        cursor-pointer
        transition-all
        hover:shadow-elevated
      "
    >
      {/* Small Arrow – top corner */}
      <div
        onClick={(e) => {
          e.stopPropagation();
          goToTreatment();
        }}
        className="
          absolute top-4 left-4
          opacity-80
          group-hover:opacity-100
          transition
        "
      >
        <ForwardBackButton />
      </div>

      {/* Title */}
      <h3 className="font-serif text-xl md:text-2xl text-foreground mb-3 group-hover:text-primary transition-colors">
        {title}
      </h3>

      {/* Description */}
      <p className="text-subtle text-sm md:text-base leading-relaxed">
        {description}
      </p>

      {/* Decorative Line */}
      <motion.div
        initial={{ scaleX: 0 }}
        whileInView={{ scaleX: 1 }}
        viewport={{ once: true }}
        transition={{ duration: 0.6, delay: 0.3 + index * 0.1 }}
        className="
          h-0.5
          bg-gradient-to-r from-primary/30 via-accent/40 to-transparent
          mt-5
          origin-left
        "
      />
    </motion.div>
  );
};

export default TreatmentCard;
