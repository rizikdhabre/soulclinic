"use client";

import axios from "axios";
import { useEffect, useMemo, useRef, useState } from "react";

const PAGE_FETCH = 20;
const PAGE_SHOW = 10;

export default function UpcomingAppointmentsList({ isOpen }) {
  const [items, setItems] = useState([]);
  const [visibleCount, setVisibleCount] = useState(0);
  const [offset, setOffset] = useState(0);
  const [hasMore, setHasMore] = useState(true);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

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
          type: "upcoming",
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
      setError("تعذر تحميل المواعيد القادمة");
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
        لا يوجد مواعيد قادمة
      </p>
    );
  }

  return (
    <div
      ref={listRef}
      className="space-y-3 max-h-[60vh] overflow-y-auto pr-1"
    >
      {visibleItems.map((item, index) => (
        <div
          key={item.appointmentId || index}
          className="border rounded-xl p-4 flex justify-between items-center"
        >
          <div>
            <p className="font-medium">{item.fullName}</p>
            <p className="text-sm text-muted-foreground">
              {item.date} - {item.time}
            </p>
          </div>

          <span className="text-muted-foreground text-sm font-medium">
            لم يأتِ موعدها بعد
          </span>
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