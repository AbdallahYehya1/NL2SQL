"use client";

import { CartesianGrid, ResponsiveContainer, Scatter, ScatterChart, Tooltip, XAxis, YAxis } from "recharts";
import { formatNumberCompact, titleCase } from "@/lib/format";
import { useReducedMotion } from "@/lib/hooks/use-reduced-motion";
import { ChartTooltip } from "./chart-tooltip";
import { AXIS_TICK, GRID_STROKE, SERIES_COLORS } from "./palette";

export function ScatterChartView({ valueKeys, rows, heightPx = 288 }: { valueKeys: [string, string]; rows: Record<string, unknown>[]; heightPx?: number }) {
  const reducedMotion = useReducedMotion();
  const [xKey, yKey] = valueKeys;

  return (
    <div className="w-full" style={{ height: heightPx }} role="img" aria-label={`Scatter plot of ${titleCase(yKey)} versus ${titleCase(xKey)}`}>
      <ResponsiveContainer width="100%" height="100%">
        <ScatterChart margin={{ top: 8, right: 16, bottom: 4, left: 4 }}>
          <CartesianGrid strokeDasharray="3 3" stroke={GRID_STROKE} />
          <XAxis type="number" dataKey={xKey} name={titleCase(xKey)} tick={AXIS_TICK} tickLine={false} axisLine={{ stroke: GRID_STROKE }} tickFormatter={(v) => formatNumberCompact(v as number)} />
          <YAxis type="number" dataKey={yKey} name={titleCase(yKey)} tick={AXIS_TICK} tickLine={false} axisLine={false} width={56} tickFormatter={(v) => formatNumberCompact(v as number)} />
          <Tooltip content={<ChartTooltip />} cursor={{ strokeDasharray: "3 3", stroke: "var(--border)" }} />
          <Scatter data={rows} fill={SERIES_COLORS[0]} isAnimationActive={!reducedMotion} animationDuration={reducedMotion ? 0 : 400} />
        </ScatterChart>
      </ResponsiveContainer>
    </div>
  );
}
