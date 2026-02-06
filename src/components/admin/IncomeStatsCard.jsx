"use client";

import { useEffect, useState } from "react";
import axios from "axios";
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

  const [amount, setAmount] = useState("");
  const [month, setMonth] = useState(new Date().toISOString().slice(0, 7));

  const fetchStats = async () => {
    try {
      setLoading(true);
      const res = await axios.get("/api/admin/income-stats");
      setData(res.data || []);
    } catch {
      setData([]);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchStats();
  }, []);

  const handleAdd = async () => {
    if (!amount) return;

    const [year, m] = month.split("-");

    await axios.post("/api/admin/income-stats", {
      year: Number(year),
      month: m,
      value: amount,
    });

    setAmount("");
    fetchStats();
  };

  return (
    <div className="card-elevated p-6 mt-6">
      <h3 className="text-lg font-semibold mb-4">الدخل الشهري</h3>

      <div className="flex-col gap-2 mb-4">
        <input
          type="month"
          value={month}
          onChange={(e) => setMonth(e.target.value)}
          className="
              border border-border rounded px-2 py-1
              bg-background text-foreground
              placeholder:text-muted-foreground
              focus:outline-none focus:ring-2 focus:ring-primary
            "
        />

        <input
          type="number"
          inputMode="numeric"
          placeholder="500 أو -250"
          value={amount}
          onChange={(e) => setAmount(e.target.value)}
          className="
            border border-border rounded px-2 py-1 w-32
            bg-background text-foreground
            placeholder:text-muted-foreground
            focus:outline-none focus:ring-2 focus:ring-primary
          "
        />

        <button
          onClick={handleAdd}
          className="px-4 py-1 rounded bg-primary text-primary-foreground"
        >
          إضافة
        </button>
      </div>

      {loading && (
        <div className="flex items-center justify-center h-[260px] text-muted-foreground">
          Loading income…
        </div>
      )}

      {!loading && data.length === 0 && (
        <div className="flex flex-col items-center justify-center h-[260px] text-center">
          <div className="mb-4 flex h-14 w-14 items-center justify-center rounded-full bg-primary/10 text-primary">
            <span className="text-2xl font-bold">₪</span>
          </div>
          <p className="text-sm text-muted-foreground">
            لم يتم تسجيل أي دخل بعد
          </p>
        </div>
      )}

      {!loading && data.length > 0 && (
        <div className="relative w-full" style={{ height: 260 }}>
          <ResponsiveContainer width="100%" height="100%">
            <LineChart
              data={data}
              margin={{ top: 10, right: 10, left: 40, bottom: 0 }}
            >
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
                formatter={(v) => [`₪${v}`, "الدخل"]}
              />

              <Line
                type="monotone"
                dataKey="income"
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

export default IncomeStatsCard;
