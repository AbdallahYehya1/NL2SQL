"use client";

import { useCountUp } from "@/lib/hooks/use-count-up";
import { formatNumberCompact, formatNumberFull } from "@/lib/format";
import type { DashboardKpi } from "@/lib/dashboard/types";

function KpiCard({ kpi, index }: { kpi: DashboardKpi; index: number }) {
  const animatable = kpi.rawValue !== undefined && (kpi.format === "number" || kpi.format === "currency");
  // Hooks must run unconditionally: always call useCountUp, feeding it a non-finite value when there's nothing to
  // animate — the hook itself returns that value as-is in that case (see use-count-up.ts), so it's a safe no-op.
  const animated = useCountUp(animatable ? kpi.rawValue! : NaN);
  const display = !animatable
    ? kpi.value
    : kpi.format === "currency"
      ? `$${formatNumberCompact(animated)}`
      : Number.isInteger(kpi.rawValue)
        ? formatNumberFull(Math.round(animated))
        : formatNumberFull(Math.round(animated * 100) / 100);

  return (
    <div className="animate-result-in rounded-2xl border border-border bg-card p-4" style={{ animationDelay: `${index * 60}ms` }}>
      <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{kpi.label}</p>
      <p className="mt-1.5 text-2xl font-semibold tabular-nums text-foreground sm:text-3xl">{display}</p>
      {kpi.description && <p className="mt-1 text-xs text-muted-foreground">{kpi.description}</p>}
    </div>
  );
}

export function KpiGrid({ kpis }: { kpis: DashboardKpi[] }) {
  if (kpis.length === 0) return null;
  return (
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
      {kpis.map((k, i) => (
        <KpiCard key={k.id} kpi={k} index={i} />
      ))}
    </div>
  );
}
