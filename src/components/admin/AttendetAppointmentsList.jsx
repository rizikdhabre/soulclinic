"use client";

import axios from "axios";
import { useEffect, useMemo, useRef, useState } from "react";
import { getWhatsAppLink } from "@/lib/phone";
import { mergeUniqueAppointments } from "@/lib/utils";

const PAGE_FETCH = 20;
const PAGE_SHOW = 10;

export default function AttendetAppointmentsList({ isOpen }) {
  const [items, setItems] = useState([]);
  const [visibleCount, setVisibleCount] = useState(0);
  const [offset, setOffset] = useState(0);
  const [hasMore, setHasMore] = useState(true);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  const listRef = useRef(null);
  const loadingRef = useRef(false);
  const hasMoreRef = useRef(true);
  const offsetRef = useRef(0);
  const requestedOffsetsRef = useRef(new Set());

  const visibleItems = useMemo(() => {
    return items.slice(0, visibleCount);
  }, [items, visibleCount]);

  const fetchBatch = async (nextOffset) => {
    const requestKey = String(nextOffset);

    if (loadingRef.current || !hasMoreRef.current) return;
    if (requestedOffsetsRef.current.has(requestKey)) return;

    loadingRef.current = true;
    requestedOffsetsRef.current.add(requestKey);
    let completed = false;

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

      setItems((prev) => mergeUniqueAppointments(prev, newItems));

      const nextServerOffset = nextOffset + newItems.length;
      offsetRef.current = nextServerOffset;
      setOffset(nextServerOffset);

      hasMoreRef.current = Boolean(data.hasMore);
      setHasMore(Boolean(data.hasMore));
      completed = true;
    } catch (error) {
      setError("تعذر تحميل البيانات");
    } finally {
      if (!completed) {
        requestedOffsetsRef.current.delete(requestKey);
      }

      loadingRef.current = false;
      setLoading(false);
    }
  };

  const resetAndLoad = async () => {
    requestedOffsetsRef.current.clear();
    loadingRef.current = false;
    hasMoreRef.current = true;
    offsetRef.current = 0;
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

    if (remainingAfterShow < PAGE_SHOW && hasMoreRef.current && !loadingRef.current) {
      await fetchBatch(offsetRef.current);
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

      if (hasMoreRef.current) {
        fetchBatch(offsetRef.current);
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
