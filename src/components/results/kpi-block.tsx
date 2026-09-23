"use client";

import { TrendingDown, TrendingUp } from "lucide-react";
import { formatNumberCompact, formatNumberFull, looksLikeCurrency, titleCase } from "@/lib/format";
import { useCountUp } from "@/lib/hooks/use-count-up";
import type { KpiSpec } from "@/components/charts/detect";

export function KpiBlock({ kpi }: { kpi: KpiSpec }) {
  const isCurrency = looksLikeCurrency(kpi.valueKey);
  const displayValue = useCountUp(kpi.value);
  const compact = Math.abs(kpi.value) >= 100000;
  const formatted = compact ? formatNumberCompact(displayValue) : formatNumberFull(displayValue);
  const deltaPositive = typeof kpi.delta === "number" && kpi.delta > 0;
  const deltaNegative = typeof kpi.delta === "number" && kpi.delta < 0;
  const deltaLooksLikePercent = kpi.deltaKey ? /pct|percent/i.test(kpi.deltaKey) : false;

  return (
    <div className="flex flex-col items-center gap-1 py-2 text-center sm:py-4">
      <p className="text-4xl font-semibold tracking-tight tabular-nums text-foreground sm:text-5xl">
        {isCurrency && "$"}
        {formatted}
      </p>
      <p className="text-sm font-medium text-muted-foreground">{titleCase(kpi.valueKey)}</p>
      {kpi.label && <p className="text-xs text-muted-foreground">{kpi.label}</p>}
      {typeof kpi.delta === "number" && (
        <span
          className={`mt-1 inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium ${
            deltaPositive ? "bg-success-bg text-success" : deltaNegative ? "bg-danger-bg text-danger" : "bg-muted text-muted-foreground"
          }`}
        >
          {deltaPositive && <TrendingUp className="h-3 w-3" aria-hidden />}
          {deltaNegative && <TrendingDown className="h-3 w-3" aria-hidden />}
          {kpi.delta > 0 ? "+" : ""}
          {deltaLooksLikePercent ? `${formatNumberFull(kpi.delta)}%` : formatNumberFull(kpi.delta)}
        </span>
      )}
    </div>
  );
}
