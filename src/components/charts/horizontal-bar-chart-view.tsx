"use client";

import { useState } from "react";
import { Bar, BarChart, CartesianGrid, Cell, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { formatNumberCompact, titleCase, truncateLabel } from "@/lib/format";
import { useReducedMotion } from "@/lib/hooks/use-reduced-motion";
import { ChartTooltip } from "./chart-tooltip";
import { AXIS_TICK, GRID_STROKE, SERIES_COLORS } from "./palette";

/** Horizontal bars: more readable than vertical bars when there are many categories or long labels. */
export function HorizontalBarChartView({ labelKey, valueKeys, rows, heightPx }: { labelKey: string; valueKeys: string[]; rows: Record<string, unknown>[]; heightPx?: number }) {
  const reducedMotion = useReducedMotion();
  const [activeIndex, setActiveIndex] = useState<number | null>(null);
  const data = rows.map((r) => ({ ...r, [labelKey]: truncateLabel(r[labelKey], 22) }));
  const singleSeries = valueKeys.length === 1;
  // enough vertical room per category so long labels don't collide, unless the caller (expanded view) fixes a height
  const height = heightPx ?? Math.max(240, Math.min(600, rows.length * 32));

  return (
    <div className="w-full" style={{ height }} role="img" aria-label={`Bar chart of ${valueKeys.map(titleCase).join(", ")} by ${titleCase(labelKey)}`}>
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={data} layout="vertical" margin={{ top: 4, right: 16, bottom: 4, left: 4 }} onMouseLeave={() => setActiveIndex(null)}>
          <CartesianGrid strokeDasharray="3 3" stroke={GRID_STROKE} horizontal={false} />
          <XAxis type="number" tick={AXIS_TICK} tickLine={false} axisLine={{ stroke: GRID_STROKE }} tickFormatter={(v) => formatNumberCompact(v as number)} />
          <YAxis type="category" dataKey={labelKey} tick={AXIS_TICK} tickLine={false} axisLine={false} width={120} />
          <Tooltip content={<ChartTooltip />} cursor={{ fill: "var(--muted)" }} />
          {valueKeys.map((k, i) => (
            <Bar
              key={k}
              dataKey={k}
              fill={SERIES_COLORS[i % SERIES_COLORS.length]}
              radius={[0, 4, 4, 0]}
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
