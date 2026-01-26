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

const IncomeStatsCard = () => {
  const [data, setData] = useState([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetch("/api/admin/income-stats")
      .then((res) => res.json())
      .then((res) => {
        setData(res || []);
        setLoading(false);
      })
      .catch(() => setLoading(false));
  }, []);

  return (
    <div className="card-elevated p-6">
      <h3 className="text-lg font-semibold mb-4">Monthly Income</h3>

      {/* Loading */}
      {loading && (
        <div className="flex items-center justify-center h-[260px] text-muted-foreground">
          Loading income…
        </div>
      )}

      {/* Empty state */}
      {!loading && data.length === 0 && (
        <div className="flex flex-col items-center justify-center h-[260px] text-center">
          <div className="mb-4 flex h-14 w-14 items-center justify-center rounded-full bg-primary/10 text-primary">
            <span className="text-2xl font-bold">₪</span>
          </div>
          <p className="text-sm text-muted-foreground">
            No income recorded yet
          </p>
          <p className="text-xs text-muted-foreground mt-1">
            Income will appear once sessions are marked as attended
          </p>
        </div>
      )}

      {/* Chart */}
      {!loading && data.length > 0 && (
        <div className="relative w-full" style={{ height: 260 }}>
          <ResponsiveContainer width="100%" height="100%">
            <LineChart data={data}>
              <CartesianGrid strokeDasharray="3 3" />
              <XAxis dataKey="month" />
              <YAxis allowDecimals={false} />
              <Tooltip formatter={(value) => [`₪${value}`, "Income"]} />
              <Line
                type="monotone"
                dataKey="income"
                stroke="var(--primary)"
                strokeWidth={3}
                dot={{ r: 4 }}
              />
            </LineChart>
          </ResponsiveContainer>
        </div>
      )}
    </div>
  );
};

export default IncomeStatsCard;
