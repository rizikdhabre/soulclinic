"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
export default function TreatmentDetails({ treatment }) {
  const id = treatment._id;
  const router = useRouter();
  const HUJAMA_ID = "69dbaf697f07ea94b798a89f";
  const isHujama = id === HUJAMA_ID;

  const [expanded, setExpanded] = useState({});


  const toggleExpand = (index) => {
    setExpanded((prev) => ({
      ...prev,
      [index]: !prev[index],
    }));
  };

  const handleBookNow = (service) => {
    const params = new URLSearchParams({
      treatmentId: id,
      duration: service.duration,
      price: service.price,
      title: service.title,
    });

    if (isHujama && service.cupsCount) {
      params.append("cupsCount", service.cupsCount);
    }

    router.push(`/appointments?${params.toString()}`);
  };

  return (
    <div className="container mx-auto px-6 py-24">
      {/* Header */}
      <div className="max-w-2xl mb-16">
        <h1 className="text-4xl font-serif mb-4">{treatment.title}</h1>
        <p className="text-muted-foreground">{treatment.description}</p>
      </div>

      {/* Services */}
      <div className="grid md:grid-cols-3 gap-10">
        {treatment.services?.map((s, i) => (
          <div
            key={i}
            className="glass-card overflow-hidden hover:shadow-elevated transition"
          >
            {/* IMAGE / PLACEHOLDER */}
            <div className="w-full h-[340px] overflow-hidden">
              {s.imageUrl ? (
                <img
                  src={s.imageUrl}
                  alt={s.title}
                  className="w-full h-full object-cover"
                  loading="lazy"
                />
              ) : (
                <div className="w-full h-full bg-muted flex items-center justify-center text-sm text-muted-foreground">
                  No image available
                </div>
              )}
            </div>

            {/* CONTENT */}
            <div className="p-6">
              <h3 className="text-xl font-semibold mb-2">{s.title}</h3>
              <div className="mb-4">
                <p
                  className={`text-subtle transition-all ${
                    expanded[i] ? "" : "line-clamp-3"
                  }`}
                >
                  {s.description}
                </p>

                {s.description.length > 10 && (
                  <button
                    onClick={() => toggleExpand(i)}
                    className="mt-2 text-sm text-primary hover:underline"
                  >
                    {expanded[i] ? "عرض أقل" : "عرض المزيد"}
                  </button>
                )}
              </div>

              <div className="flex flex-col gap-4 text-sm font-medium">
                <div className="flex justify-between">
                  <span>المدة: {s.duration}</span>
                  <span>
                    السعر: {s.price} {s.currency}
                  </span>
                </div>

                <button
                  onClick={() => handleBookNow(s)}
                  className="mt-2 w-full rounded-xl bg-primary py-3 text-white transition hover:bg-primary/90"
                >
                  احجز الآن
                </button>
              </div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
