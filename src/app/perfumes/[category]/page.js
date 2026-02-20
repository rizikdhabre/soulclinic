"use client";

import { useEffect, useState } from "react";
import axios from "axios";
import { useParams } from "next/navigation";
import { motion, AnimatePresence } from "framer-motion";
import Image from "next/image";
import NeonLoader from "@/components/ui/loading";

export default function CategoryPage() {
  const { category } = useParams();
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(false);
  const [selected, setSelected] = useState(null);
  const [loaderSize, setLoaderSize] = useState({ w: 260, h: 70 });

  useEffect(() => {
    const calculateSize = () => {
      const width = window.innerWidth;
      if (width < 640) return { w: 220, h: 60 };
      if (width < 1024) return { w: 280, h: 70 };
      return { w: 360, h: 80 };
    };
    setLoaderSize(calculateSize());
  }, []);

  useEffect(() => {
    if (!category) return;

    const fetchCategory = async () => {
      try {
        setLoading(true);
        const res = await axios.get(`/api/perfumes/${category}`);
        setData(res.data);
      } catch (err) {
        console.error("Failed:", err);
      } finally {
        setLoading(false);
      }
    };

    fetchCategory();
  }, [category]);

  if (loading) {
    return (
      <div className="min-h-screen flex flex-col items-center justify-center gap-6 bg-background">
        <NeonLoader width={loaderSize.w} height={loaderSize.h} />
        <p className="text-muted-foreground text-lg">جاري تحميل الفئة...</p>
      </div>
    );
  }

  if (!data) {
    return (
      <div className="py-20 text-center text-muted-foreground bg-background">
        Not Found
      </div>
    );
  }

  return (
    <main className="relative bg-background text-foreground overflow-hidden">
      {/* HERO */}
      <section className="relative py-28 px-6 md:px-16 text-center">
        <motion.div
          initial={{ opacity: 0, y: 60 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 1, ease: [0.22, 1, 0.36, 1] }}
          className="space-y-6"
        >
          <h1 className="font-serif text-4xl md:text-6xl font-light tracking-wide">
            {data.name}
          </h1>

          {data.description && (
            <p className="max-w-2xl mx-auto text-muted-foreground text-sm md:text-base">
              {data.description}
            </p>
          )}
        </motion.div>
      </section>

      {/* GRID */}
      <section className="relative px-6 md:px-16 pb-24">
        <div className="max-w-7xl mx-auto grid grid-cols-2 lg:grid-cols-4 gap-6 md:gap-8 place-items-center">
          {data.perfumes.map((perfume, index) => (
            <motion.div
              key={perfume._id}
              initial={{ opacity: 0, y: 60 }}
              whileInView={{ opacity: 1, y: 0 }}
              transition={{
                duration: 0.8,
                delay: index * 0.1,
                ease: [0.22, 1, 0.36, 1],
              }}
              onClick={() => setSelected(perfume)}
             className="group w-full max-w-sm h-[500px] cursor-pointer"

            >
         <div className="rounded-sm border border-border bg-card/60 backdrop-blur-md transition-all duration-700 group-hover:shadow-2xl group-hover:-translate-y-2 group-hover:scale-[1.02] overflow-hidden flex flex-col h-full">

             <div className="relative h-[340px] flex items-center justify-center bg-secondary/30 overflow-hidden">

                  {perfume.imageUrl ? (
                    <Image
                      src={perfume.imageUrl}
                      alt={perfume.name}
                      fill
                      sizes="(max-width: 640px) 50vw,
                             (max-width: 1024px) 50vw,
                             25vw"
                      priority={index === 0}
                      loading={index === 0 ? "eager" : "lazy"}
                      className="object-cover transition-transform duration-700 group-hover:scale-110"
                    />
                  ) : (
                    <div className="flex items-center justify-center w-full h-full text-muted-foreground text-sm">
                      لا يوجد صوره
                    </div>
                  )}
                </div>

                <div className="p-5 flex flex-col gap-2 min-h-[110px]">
                  <h3 className="font-serif text-lg tracking-wide">
                    {perfume.name}
                  </h3>

                  {perfume.description && (
                    <p className="text-xs text-muted-foreground">
                      اضغط لعرض الوصف
                    </p>
                  )}

                  <div className="flex items-center justify-between pt-1">
                    <span className="text-[11px] uppercase tracking-[0.15em] text-muted-foreground">
                      {perfume.size} مل
                    </span>
                    <span className="text-accent font-semibold">
                      {perfume.price} ₪
                                  
                    </span>
                  </div>
                </div>
              </div>
            </motion.div>
          ))}
        </div>
      </section>

      <AnimatePresence>
        {selected && (
          <motion.div
            initial={{ rotateY: 90, opacity: 0 }}
            animate={{ rotateY: 0, opacity: 1 }}
            exit={{ rotateY: 90, opacity: 0 }}
            transition={{ duration: 0.6, ease: [0.22, 1, 0.36, 1] }}
            className="fixed inset-0 z-50 bg-background flex items-center justify-center p-6 overflow-y-auto"
          >
            <div className="relative w-full max-w-5xl bg-card border border-border rounded-lg shadow-2xl max-h-[90vh] overflow-y-auto">
              {/* CLOSE BUTTON */}
              <button
                onClick={() => setSelected(null)}
                className="absolute top-4 right-4 text-foreground text-2xl hover:text-primary transition"
              >
                ✕
              </button>

              <div className="grid md:grid-cols-2 gap-12 p-12">
                {/* Smaller Image */}
                <div className="flex items-center justify-center">
                  <div className="relative w-full max-w-xs aspect-[3/4] bg-secondary/30 rounded-md overflow-hidden">
                    {selected.imageUrl ? (
                      <Image
                        src={selected.imageUrl}
                        alt={selected.name}
                        fill
                        sizes="(max-width: 768px) 80vw, 320px"
                        className="object-contain"
                      />
                    ) : (
                      <div className="flex items-center justify-center w-full h-full text-muted-foreground">
                        لا يوجد صوره
                      </div>
                    )}
                  </div>
                </div>

                {/* Bigger Content */}
                <div className="flex flex-col justify-center space-y-8">
                  <h2 className="font-serif text-4xl md:text-5xl text-primary">
                    {selected.name}
                  </h2>

                  <p className="text-base md:text-lg text-muted-foreground leading-relaxed">
                    {selected.description}
                  </p>

                  <div className="flex items-center justify-between pt-6 border-t border-border">
                    <span className="text-sm uppercase tracking-widest text-muted-foreground">
                      {selected.size} ml
                    </span>

                    <span className="text-2xl font-serif text-primary">
                      {selected.price} NIS
                    </span>
                  </div>
                </div>
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </main>
  );
}
