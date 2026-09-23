"use client";

import { formatNumberFull } from "@/lib/format";
import { titleCase } from "@/lib/format";

interface TooltipPayloadItem {
  name?: string;
  dataKey?: string | number;
  value?: number | string;
  color?: string;
}

/** Consistent tooltip for every chart: full label (never truncated), full-precision numbers, one row per series. */
export function ChartTooltip({ active, label, payload }: { active?: boolean; label?: string | number; payload?: TooltipPayloadItem[] }) {
  if (!active || !payload || payload.length === 0) return null;
  return (
    <div className="rounded-lg border border-border bg-card px-3 py-2 text-xs shadow-md">
      {label !== undefined && <p className="mb-1 font-medium text-foreground">{String(label)}</p>}
      <div className="space-y-0.5">
        {payload.map((p, i) => (
          <div key={i} className="flex items-center gap-2">
            <span className="h-2 w-2 shrink-0 rounded-full" style={{ background: p.color }} aria-hidden />
            <span className="text-muted-foreground">{titleCase(String(p.dataKey ?? p.name ?? ""))}:</span>
            <span className="font-semibold tabular-nums text-foreground">{typeof p.value === "number" ? formatNumberFull(p.value) : String(p.value ?? "")}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
