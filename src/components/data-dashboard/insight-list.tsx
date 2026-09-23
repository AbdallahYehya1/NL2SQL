"use client";

import { AlertTriangle, ArrowDown, ArrowUp, Layers, Scale, ShieldAlert, TrendingUp } from "lucide-react";
import { useState } from "react";
import { formatNumberFull } from "@/lib/format";
import type { InsightFact, InsightFactType } from "@/lib/dashboard/types";

const ICON: Record<InsightFactType, React.ComponentType<{ className?: string }>> = {
  TREND: TrendingUp,
  PEAK: ArrowUp,
  LOW: ArrowDown,
  COMPARISON: Scale,
  DISTRIBUTION: Layers,
  CONCENTRATION: Layers,
  ANOMALY: AlertTriangle,
  DATA_QUALITY: ShieldAlert,
};

function InsightItem({ fact }: { fact: InsightFact }) {
  const [open, setOpen] = useState(false);
  const Icon = ICON[fact.type];
  const evidence = `Based on ${fact.sourceTables.join(" · ")} — ${fact.sourceColumns.length} column${fact.sourceColumns.length === 1 ? "" : "s"} analyzed`;
  const calculation = [
    `Metric: ${fact.metric}`,
    fact.value !== undefined ? `Value: ${formatNumberFull(fact.value)}` : undefined,
    fact.previousValue !== undefined ? `Compared with: ${formatNumberFull(fact.previousValue)}` : undefined,
    fact.category ? `Category: ${fact.category}` : undefined,
    fact.period ? `Period: ${fact.period}` : undefined,
    `Source: ${fact.sourceTables.map((t) => fact.sourceColumns.map((c) => `${t}.${c}`).join(", ")).join(" / ") || fact.sourceTables.join(", ")}`,
  ].filter(Boolean);

  return (
    <li className="rounded-xl border border-border bg-card p-3.5">
      <div className="flex items-start gap-2.5">
        <span className="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-accent text-primary" aria-hidden>
          <Icon className="h-3.5 w-3.5" />
        </span>
        <div className="min-w-0 flex-1 space-y-1">
          <p className="text-sm text-foreground">{fact.statement}</p>
          <p className="text-xs text-muted-foreground">{evidence}</p>
          <button type="button" onClick={() => setOpen((v) => !v)} className="text-xs font-medium text-primary underline-offset-2 hover:underline">
            {open ? "Hide calculation" : "View calculation"}
          </button>
          {open && (
            <ul className="mt-1 space-y-0.5 rounded-lg bg-muted/50 p-2 font-mono text-xs text-muted-foreground">
              {calculation.map((line) => (
                <li key={line}>{line}</li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </li>
  );
}

export function InsightList({ insights }: { insights: InsightFact[] }) {
  if (insights.length === 0) return null;
  return (
    <div className="space-y-3">
      <h2 className="text-sm font-semibold text-foreground">Insights</h2>
      <ul className="space-y-2">
        {insights.map((f) => (
          <InsightItem key={f.id} fact={f} />
        ))}
      </ul>
    </div>
  );
}
