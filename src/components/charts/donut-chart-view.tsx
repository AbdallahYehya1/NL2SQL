"use client";

import { useState } from "react";
import { Cell, Pie, PieChart, ResponsiveContainer, Tooltip } from "recharts";
import { formatNumberFull, titleCase, truncateLabel } from "@/lib/format";
import { useReducedMotion } from "@/lib/hooks/use-reduced-motion";
import { ChartTooltip } from "./chart-tooltip";
import { SERIES_COLORS } from "./palette";

const EXTENDED_COLORS = [...SERIES_COLORS, "#22c55e", "#a855f7", "#0ea5e9"];

export function DonutChartView({ labelKey, valueKey, rows, heightPx = 256 }: { labelKey: string; valueKey: string; rows: Record<string, unknown>[]; heightPx?: number }) {
  const reducedMotion = useReducedMotion();
  const [activeIndex, setActiveIndex] = useState<number | null>(null);
  const total = rows.reduce((sum, r) => sum + (typeof r[valueKey] === "number" ? (r[valueKey] as number) : 0), 0);
  const data = rows.map((r) => ({ name: truncateLabel(r[labelKey], 20), [valueKey]: r[valueKey] }));

  return (
    <div className="flex flex-col items-center gap-3">
      <div className="w-full max-w-xs" style={{ height: heightPx }} role="img" aria-label={`Breakdown of ${titleCase(valueKey)} by ${titleCase(labelKey)}`}>
        <ResponsiveContainer width="100%" height="100%">
          <PieChart>
            <Tooltip content={<ChartTooltip />} />
            <Pie
              data={data}
              dataKey={valueKey}
              nameKey="name"
              innerRadius="60%"
              outerRadius="90%"
              paddingAngle={2}
              isAnimationActive={!reducedMotion}
              animationDuration={reducedMotion ? 0 : 500}
              onMouseEnter={(_, idx) => setActiveIndex(idx)}
              onMouseLeave={() => setActiveIndex(null)}
            >
              {data.map((_, i) => (
                <Cell key={i} fill={EXTENDED_COLORS[i % EXTENDED_COLORS.length]} fillOpacity={activeIndex === null || activeIndex === i ? 1 : 0.4} stroke="var(--card)" strokeWidth={2} />
              ))}
            </Pie>
          </PieChart>
        </ResponsiveContainer>
      </div>
      <ul className="flex flex-wrap justify-center gap-x-4 gap-y-1.5 text-xs">
        {data.map((d, i) => {
          const v = typeof d[valueKey] === "number" ? (d[valueKey] as number) : 0;
          const pct = total > 0 ? Math.round((v / total) * 1000) / 10 : 0;
          return (
            <li key={i} className={`flex items-center gap-1.5 transition-opacity ${activeIndex !== null && activeIndex !== i ? "opacity-40" : ""}`}>
              <span className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ background: EXTENDED_COLORS[i % EXTENDED_COLORS.length] }} aria-hidden />
              <span className="text-muted-foreground">{d.name}</span>
              <span className="font-medium tabular-nums text-foreground">{formatNumberFull(v)}</span>
              <span className="text-muted-foreground">({pct}%)</span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
