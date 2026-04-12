"use client";

import axios from "axios";
import { useEffect, useMemo, useRef, useState } from "react";

const PAGE_FETCH = 20;
const PAGE_SHOW = 10;

export default function AttendetAppointmentsList({ isOpen }) {
  const [items, setItems] = useState([]);
  const [visibleCount, setVisibleCount] = useState(0);
  const [offset, setOffset] = useState(0);
  const [hasMore, setHasMore] = useState(true);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  const getWhatsAppLink = (phone) => {
    const digits = String(phone || "").replace(/\D/g, "");
    const normalized = digits.startsWith("0")
      ? `972${digits.slice(1)}`
      : digits;

    return `https://wa.me/${normalized}`;
  };

  const listRef = useRef(null);

  const visibleItems = useMemo(() => {
    return items.slice(0, visibleCount);
  }, [items, visibleCount]);

  const fetchBatch = async (nextOffset) => {
    if (loading || !hasMore) return;

    try {
      setLoading(true);
      setError("");

      const res = await axios.get("/api/admin/attendance", {
        params: {
          type: "attended",
          offset: nextOffset,
          limit: PAGE_FETCH,
        },
      });

      const data = res.data;
      const newItems = Array.isArray(data.items) ? data.items : [];

      setItems((prev) => [...prev, ...newItems]);
      setOffset(nextOffset + newItems.length);
      setHasMore(Boolean(data.hasMore));
    } catch (error) {
      setError("تعذر تحميل البيانات");
    } finally {
      setLoading(false);
    }
  };

  const resetAndLoad = async () => {
    setItems([]);
    setVisibleCount(0);
    setOffset(0);
    setHasMore(true);
    await fetchBatch(0);
  };

  useEffect(() => {
    if (!isOpen) return;
    resetAndLoad();
  }, [isOpen]);

  useEffect(() => {
    if (!isOpen) return;

    if (items.length > 0 && visibleCount === 0) {
      setVisibleCount(Math.min(PAGE_SHOW, items.length));
    }
  }, [items, visibleCount, isOpen]);

  const loadNextTen = async () => {
    const nextVisible = Math.min(visibleCount + PAGE_SHOW, items.length);
    setVisibleCount(nextVisible);

    const remainingAfterShow = items.length - nextVisible;

    if (remainingAfterShow < PAGE_SHOW && hasMore && !loading) {
      await fetchBatch(offset);
    }
  };

  useEffect(() => {
    const element = listRef.current;
    if (!element) return;

    const onScroll = () => {
      const nearBottom =
        element.scrollTop + element.clientHeight >= element.scrollHeight - 50;

      if (!nearBottom || loading) return;

      const canShowMoreFromBuffer = visibleCount < items.length;

      if (canShowMoreFromBuffer) {
        loadNextTen();
        return;
      }

      if (hasMore) {
        fetchBatch(offset);
      }
    };

    element.addEventListener("scroll", onScroll);
    return () => element.removeEventListener("scroll", onScroll);
  }, [visibleCount, items.length, hasMore, loading, offset]);

  if (error) {
    return <p className="text-center text-destructive text-sm">{error}</p>;
  }

  if (!loading && visibleItems.length === 0) {
    return (
      <p className="text-center text-muted-foreground">
        لا يوجد مواعيد تم حضورها
      </p>
    );
  }

  return (
    <div ref={listRef} className="space-y-3 max-h-[60vh] overflow-y-auto pr-1">
      {visibleItems.map((item, index) => (
        <div
          key={item.appointmentId || index}
          className="border rounded-xl p-4 flex justify-between items-center"
        >
          <div className="min-w-0 flex-1 space-y-3">
            <p className="font-medium break-words">{item.fullName}</p>

            <div className="flex flex-wrap gap-2">
              <a
                href={`tel:${item.phone}`}
                className="inline-flex items-center justify-center rounded-full border px-4 py-1.5 text-sm font-medium transition hover:bg-muted"
              >
                اتصال
              </a>

              <a
                href={getWhatsAppLink(item.phone)}
                target="_blank"
                rel="noreferrer"
                className="inline-flex items-center justify-center rounded-full border px-4 py-1.5 text-sm font-medium text-green-600 transition hover:bg-green-50"
              >
                واتساب
              </a>
            </div>

            <p className="text-sm text-muted-foreground">
              {item.date} - {item.time}
            </p>
          </div>

          <a
            target="_blank"
            rel="noopener noreferrer"
            className="text-success text-sm font-medium"
          >
            حضر
          </a>
        </div>
      ))}

      {loading && (
        <p className="text-center text-sm text-muted-foreground">
          جاري التحميل...
        </p>
      )}
    </div>
  );
}
