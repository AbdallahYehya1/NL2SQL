"use client";

import { CartesianGrid, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { formatDateLabel, formatNumberCompact, isDateLike, titleCase, truncateLabel } from "@/lib/format";
import { useReducedMotion } from "@/lib/hooks/use-reduced-motion";
import { ChartTooltip } from "./chart-tooltip";
import { AXIS_TICK, GRID_STROKE, SERIES_COLORS } from "./palette";

export function LineChartView({ labelKey, valueKeys, rows, heightPx = 288 }: { labelKey: string; valueKeys: string[]; rows: Record<string, unknown>[]; heightPx?: number }) {
  const reducedMotion = useReducedMotion();
  const data = rows.map((r) => ({ ...r, [labelKey]: isDateLike(r[labelKey]) ? formatDateLabel(r[labelKey]) : truncateLabel(r[labelKey]) }));

  return (
    <div className="w-full" style={{ height: heightPx }} role="img" aria-label={`Line chart of ${valueKeys.map(titleCase).join(", ")} by ${titleCase(labelKey)}`}>
      <ResponsiveContainer width="100%" height="100%">
        <LineChart data={data} margin={{ top: 8, right: 12, bottom: 4, left: 4 }}>
          <CartesianGrid strokeDasharray="3 3" stroke={GRID_STROKE} />
          <XAxis dataKey={labelKey} tick={AXIS_TICK} tickLine={false} axisLine={{ stroke: GRID_STROKE }} />
          <YAxis tick={AXIS_TICK} width={56} tickLine={false} axisLine={false} tickFormatter={(v) => formatNumberCompact(v as number)} />
          <Tooltip content={<ChartTooltip />} cursor={{ stroke: "var(--primary)", strokeWidth: 1, strokeDasharray: "3 3" }} />
          {valueKeys.map((k, i) => (
            <Line
              key={k}
              type="monotone"
              dataKey={k}
              stroke={SERIES_COLORS[i % SERIES_COLORS.length]}
              strokeWidth={2}
              dot={{ r: 3 }}
              activeDot={{ r: 5 }}
              name={titleCase(k)}
              isAnimationActive={!reducedMotion}
              animationDuration={reducedMotion ? 0 : 500}
            />
          ))}
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}
