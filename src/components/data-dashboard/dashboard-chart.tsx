"use client";

import { BarChart3, Maximize2, Table2 } from "lucide-react";
import { useState } from "react";
import { ChartErrorBoundary } from "@/components/charts/chart-error-boundary";
import { ChartRenderer } from "@/components/charts/chart-renderer";
import { ResultTable } from "@/components/result-table/result-table";
import { Button } from "@/components/ui/button";
import { Modal } from "@/components/ui/modal";
import type { DashboardVisualizationData } from "@/lib/dashboard/types";

/**
 * Reuses the exact same chart rendering primitives as a query result's ChartView (ChartRenderer, ChartErrorBoundary,
 * ResultTable) — only the title/description header differs, since the dashboard already has a real analytical title
 * for each visualization and doesn't need the question-derived title heuristic ChartView uses for query results.
 */
export function DashboardChart({ viz, large }: { viz: DashboardVisualizationData; large?: boolean }) {
  const [view, setView] = useState<"chart" | "table">("chart");
  const [expanded, setExpanded] = useState(false);
  const table = <ResultTable columns={viz.columns} rows={viz.rows} truncated={false} />;

  return (
    <div className="animate-result-in rounded-2xl border border-border bg-card p-4 sm:p-5">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <h3 className="text-sm font-semibold text-foreground">{viz.title}</h3>
          {viz.description && <p className="text-xs text-muted-foreground">{viz.description}</p>}
        </div>
        <div className="flex items-center gap-1.5">
          <div className="flex rounded-lg border border-border p-0.5" role="group" aria-label="Chart view">
            <Button size="sm" variant={view === "chart" ? "subtle" : "ghost"} aria-pressed={view === "chart"} onClick={() => setView("chart")}>
              <BarChart3 className="h-3.5 w-3.5" aria-hidden /> Chart
            </Button>
            <Button size="sm" variant={view === "table" ? "subtle" : "ghost"} aria-pressed={view === "table"} onClick={() => setView("table")}>
              <Table2 className="h-3.5 w-3.5" aria-hidden /> Table
            </Button>
          </div>
          {view === "chart" && (
            <Button size="icon" variant="ghost" aria-label="Expand chart" onClick={() => setExpanded(true)}>
              <Maximize2 className="h-3.5 w-3.5" aria-hidden />
            </Button>
          )}
        </div>
      </div>
      <div className="mt-3 transition-opacity duration-200" key={view}>
        {view === "chart" ? (
          <ChartErrorBoundary fallback={table}>
            <ChartRenderer spec={viz.spec} rows={viz.rows} heightPx={large ? 320 : 240} />
          </ChartErrorBoundary>
        ) : (
          table
        )}
      </div>
      <Modal open={expanded} onClose={() => setExpanded(false)} title={viz.title}>
        <ChartErrorBoundary fallback={table}>
          <ChartRenderer spec={viz.spec} rows={viz.rows} heightPx={typeof window !== "undefined" && window.innerHeight < 700 ? 360 : 480} />
        </ChartErrorBoundary>
      </Modal>
    </div>
  );
}
