"use client";

import { useEffect, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import NeonLoader from "@/components/ui/loading";
export default function TreatmentDetails() {
  const { id } = useParams();
  const router = useRouter();
  const HUJAMA_ID = "6971f64c9b98d43b59cbb4a0";
  const isHujama = id === HUJAMA_ID;
  const [loading, setLoading] = useState(true);

  const [expanded, setExpanded] = useState({});

  const [treatment, setTreatment] = useState(null);
  const [error, setError] = useState(null);

  const toggleExpand = (index) => {
    setExpanded((prev) => ({
      ...prev,
      [index]: !prev[index],
    }));
  };

  useEffect(() => {
    if (!id) return;

    const fetchTreatment = async () => {
      try {
        setLoading(true);

        const res = await fetch(`/api/treatment?id=${id}`);
        if (!res.ok) throw new Error("Failed to fetch treatment");

        const data = await res.json();
        setTreatment(data);
      } catch (err) {
        setError("Failed to load treatment");
      } finally {
        setLoading(false);
      }
    };

    fetchTreatment();
  }, [id]);

  if (loading) {
    return (
      <div className="min-h-screen flex flex-col items-center justify-center gap-6 bg-background">
        <NeonLoader width={320} height={80} />

        <p className="text-muted-foreground text-lg tracking-wide animate-pulse">
          جاري التحميل...
        </p>
      </div>
    );
  }

  if (error) {
    return (
      <div className="container mx-auto px-6 py-24 text-center text-muted-foreground">
        {error}
      </div>
    );
  }

  if (!treatment) return null;

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
