"use client";

import { useState } from "react";
import { Bar, BarChart, CartesianGrid, Cell, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { formatNumberCompact, titleCase, truncateLabel } from "@/lib/format";
import { useReducedMotion } from "@/lib/hooks/use-reduced-motion";
import { ChartTooltip } from "./chart-tooltip";
import { AXIS_TICK, GRID_STROKE, SERIES_COLORS } from "./palette";

export function BarChartView({ labelKey, valueKeys, rows, heightPx = 288 }: { labelKey: string; valueKeys: string[]; rows: Record<string, unknown>[]; heightPx?: number }) {
  const reducedMotion = useReducedMotion();
  const [activeIndex, setActiveIndex] = useState<number | null>(null);
  const data = rows.map((r) => ({ ...r, [labelKey]: truncateLabel(r[labelKey], 14) }));
  const angled = rows.length > 6;
  const singleSeries = valueKeys.length === 1;

  return (
    <div className="w-full" style={{ height: heightPx }} role="img" aria-label={`Bar chart of ${valueKeys.map(titleCase).join(", ")} by ${titleCase(labelKey)}`}>
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={data} margin={{ top: 8, right: 12, bottom: 4, left: 4 }} onMouseLeave={() => setActiveIndex(null)}>
          <CartesianGrid strokeDasharray="3 3" stroke={GRID_STROKE} vertical={false} />
          <XAxis dataKey={labelKey} tick={AXIS_TICK} tickLine={false} axisLine={{ stroke: GRID_STROKE }} interval={0} angle={angled ? -25 : 0} textAnchor={angled ? "end" : "middle"} height={angled ? 56 : 28} />
          <YAxis tick={AXIS_TICK} width={56} tickLine={false} axisLine={false} tickFormatter={(v) => formatNumberCompact(v as number)} />
          <Tooltip content={<ChartTooltip />} cursor={{ fill: "var(--muted)" }} />
          {valueKeys.map((k, i) => (
            <Bar
              key={k}
              dataKey={k}
              fill={SERIES_COLORS[i % SERIES_COLORS.length]}
              radius={[4, 4, 0, 0]}
              name={titleCase(k)}
              isAnimationActive={!reducedMotion}
              animationDuration={reducedMotion ? 0 : 400}
              onMouseEnter={(_, idx) => setActiveIndex(idx)}
            >
              {singleSeries && data.map((_, idx) => <Cell key={idx} fillOpacity={activeIndex === null || activeIndex === idx ? 1 : 0.45} />)}
            </Bar>
          ))}
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}
