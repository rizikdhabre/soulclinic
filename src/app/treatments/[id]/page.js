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

  const [treatment, setTreatment] = useState(null);
  const [error, setError] = useState(null);

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
      <div className="grid md:grid-cols-2 gap-10">
        {treatment.services?.map((s, i) => (
          <div
            key={i}
            className="glass-card overflow-hidden hover:shadow-elevated transition"
          >
            {s.imageUrl ? (
              <img
                src={s.imageUrl}
                alt={s.title}
                className="w-full h-56 object-cover"
                loading="lazy"
              />
            ) : (
              <div className="w-full h-56 bg-muted flex items-center justify-center text-sm text-muted-foreground">
                No image available
              </div>
            )}

            <div className="p-6">
              <h3 className="text-xl font-semibold mb-2">{s.title}</h3>
              <p className="text-subtle mb-4">{s.description}</p>

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
