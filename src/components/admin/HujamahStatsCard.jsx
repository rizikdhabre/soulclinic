"use client";

import { useEffect, useState } from "react";
import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
} from "recharts";
import { Activity } from "lucide-react";

const HujamahStatsCard = () => {
  const [data, setData] = useState([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetch("/api/admin/hujamah-stats")
      .then((res) => res.json())
      .then((res) => {
        setData(res || []);
        setLoading(false);
      })
      .catch(() => setLoading(false));
  }, []);

  return (
    <div className="card-elevated p-6">
      <h3 className="text-lg font-semibold mb-4">استخدام الحجامة (شهريًا)</h3>

      {/* Loading */}
      {loading && (
        <div className="flex items-center justify-center h-[260px] text-muted-foreground">
          Loading statistics…
        </div>
      )}

      {/* Empty state */}
      {!loading && data.length === 0 && (
        <div className="flex flex-col items-center justify-center h-[260px] text-center">
          <div className="mb-4 flex h-14 w-14 items-center justify-center rounded-full bg-primary/10 text-primary">
            <Activity size={28} />
          </div>
          <p className="text-sm text-muted-foreground">
            لم يتم تسجيل أي جلسات حجامة بعد
          </p>
          <p className="text-xs text-muted-foreground mt-1">
            ستظهر الإحصائيات عند تسجيل الجلسات كمحضورة
          </p>
        </div>
      )}

      {/* Chart (ONLY when data exists) */}
      {!loading && data.length > 0 && (
        <div className="relative w-full" style={{ height: 260 }}>
          <ResponsiveContainer width="100%" height="100%">
            <LineChart data={data}>
              <CartesianGrid
                stroke="hsl(var(--border))"
                strokeDasharray="3 3"
              />

              <XAxis dataKey="month" stroke="hsl(var(--muted-foreground))" />

              <YAxis
                allowDecimals={false}
                stroke="hsl(var(--muted-foreground))"
                orientation="left"
                mirror={false}
                tickMargin={10}
              />

              <Tooltip
                contentStyle={{
                  backgroundColor: "hsl(var(--background))",
                  border: "1px solid hsl(var(--border))",
                  color: "hsl(var(--foreground))",
                }}
                labelStyle={{ color: "hsl(var(--foreground))" }}
                formatter={(v) => [v, "عدد الكؤوس"]}
              />

              <Line
                type="monotone"
                dataKey="cups"
                stroke="hsl(var(--primary))"
                strokeWidth={3}
                dot={{ r: 4, fill: "hsl(var(--primary))" }}
              />
            </LineChart>
          </ResponsiveContainer>
        </div>
      )}
    </div>
  );
};

export default HujamahStatsCard;
