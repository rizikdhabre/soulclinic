"use client";

import { useEffect, useState } from "react";
import axios from "axios";
import Image from "next/image";
import Link from "next/link";
import NeonLoader from "@/components/ui/loading";

export default function PerfumesPage() {
  const [categories, setCategories] = useState([]);
  const [loading, setLoading] = useState(false);
  const [loaderSize, setLoaderSize] = useState({ w: 260, h: 70 });

  useEffect(() => {
    const calculateSize = () => {
      const width = window.innerWidth;
      if (width < 640) return { w: 220, h: 60 };
      if (width < 1024) return { w: 280, h: 70 };
      return { w: 360, h: 80 };
    };

    setLoaderSize(calculateSize());
    window.addEventListener("resize", () => setLoaderSize(calculateSize()));
  }, []);

  useEffect(() => {
    const fetchPerfumes = async () => {
      try {
        setLoading(true);
        const res = await axios.get("/api/perfumes", {
          cache: "no-store",
        });
        setCategories(res.data || []);
      } catch (err) {
        console.error("Failed:", err);
      } finally {
        setLoading(false);
      }
    };

    fetchPerfumes();
  }, []);

  if (loading) {
    return (
      <div className="min-h-screen flex flex-col items-center justify-center gap-6">
        <NeonLoader width={loaderSize.w} height={loaderSize.h} />
        <p className="text-muted-foreground text-lg">جاري تحميل العطور...</p>
      </div>
    );
  }

  return (
    <main className="relative w-full bg-background text-foreground">
      <section
        id="perfume-categories"
        className="px-6 md:px-16 py-20 space-y-24"
      >
        {categories.map((category) => (
          <div key={category._id} className="space-y-12">
            {/* Category Header */}
            <div className="space-y-6 text-center">
              <h2 className="text-3xl md:text-4xl font-semibold tracking-tight">
                {category.name}
              </h2>

              <Link
                href={`/perfumes/${category.name.toLowerCase()}`}
                className="inline-flex items-center justify-center px-6 py-2 rounded-full border border-accent text-accent text-lg font-medium hover:bg-accent hover:text-background transition-all duration-300"
              >
                عرض الكل ←
              </Link>
            </div>

            {/* Perfume Grid */}
            <div className="grid grid-cols-2 md:grid-cols-4 gap-6 md:gap-8">
              {(category.perfumes || []).slice(0, 4).map((perfume, index) => (
                <div
                  key={perfume._id}
                  className="group relative bg-card rounded-2xl overflow-hidden shadow-card hover:shadow-2xl transition-all duration-500 hover:-translate-y-2 hover:scale-[1.03]"
                >
                  <div className="relative w-full h-56 md:h-64 overflow-hidden">
                    {perfume.imageUrl ? (
                      <Image
                        src={perfume.imageUrl}
                        alt={perfume.name}
                        fill
                        sizes="(max-width: 768px) 50vw,
                        (max-width: 1200px) 25vw,
                        25vw"
                        priority={index === 0}
                        loading={index === 0 ? "eager" : "lazy"}
                        className="object-cover transition-transform duration-700 group-hover:scale-110"
                      />
                    ) : (
                      <div className="flex items-center justify-center w-full h-full text-muted-foreground text-sm bg-secondary/30">
                        لا يوجد صوره
                      </div>
                    )}
                  </div>

                  <div className="p-5 space-y-2">
                    <h3 className="text-lg font-medium">{perfume.name}</h3>
                    <p className="text-sm text-muted-foreground">
                      {perfume.size} ml
                    </p>

                    <p className="text-accent font-semibold">
                      {perfume.price} NIS
                    </p>
                  </div>
                </div>
              ))}
            </div>
          </div>
        ))}
      </section>
    </main>
  );
}
