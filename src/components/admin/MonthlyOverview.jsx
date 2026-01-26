"use client";

import { useState } from "react";
import { Calendar } from "lucide-react";

const months = [
  { name: "January", short: "Jan", count: 47 },
  { name: "February", short: "Feb", count: 38 },
  { name: "March", short: "Mar", count: 52 },
];

const MonthlyOverview = () => {
  const [selected, setSelected] = useState(0);

  return (
    <div className="card-elevated p-6">
      <h3 className="text-lg font-semibold mb-4">Monthly Overview</h3>

      <div className="grid grid-cols-3 gap-3">
        {months.map((m, i) => (
          <button
            key={m.name}
            onClick={() => setSelected(i)}
            className={`month-tile ${
              selected === i ? "month-tile-selected" : ""
            }`}
          >
            <Calendar />
            <p>{m.short}</p>
            <strong>{m.count}</strong>
          </button>
        ))}
      </div>
    </div>
  );
};

export default MonthlyOverview;
