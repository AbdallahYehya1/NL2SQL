"use client";

import { BarChart3, Maximize2, Table2 } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Modal } from "@/components/ui/modal";
import { chartTitleFromColumns, chartTitleFromQuestion, titleCase } from "@/lib/format";
import { ChartErrorBoundary } from "./chart-error-boundary";
import { ChartRenderer } from "./chart-renderer";
import type { VisualizationSpec } from "./detect";

function titleFor(spec: VisualizationSpec, question: string): string {
  const fallback =
    spec.type === "scatter" && spec.valueKeys?.length === 2
      ? `${titleCase(spec.valueKeys[1])} vs ${titleCase(spec.valueKeys[0])}`
      : spec.labelKey && spec.valueKeys?.length
        ? chartTitleFromColumns(spec.labelKey, spec.valueKeys)
        : "Result";
  return question ? chartTitleFromQuestion(question, fallback) : fallback;
}

export function ChartView({
  spec,
  rows,
  question,
  view,
  onViewChange,
  table,
}: {
  spec: VisualizationSpec;
  rows: Record<string, unknown>[];
  question: string;
  view: "chart" | "table";
  onViewChange: (v: "chart" | "table") => void;
  /** The table to show when view === "table", or as the error-boundary fallback if the chart itself throws. */
  table: React.ReactNode;
}) {
  const [expanded, setExpanded] = useState(false);
  const title = titleFor(spec, question);

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-sm font-semibold text-foreground">{title}</h3>
        <div className="flex items-center gap-1.5">
          <div className="flex rounded-lg border border-border p-0.5" role="group" aria-label="Result view">
            <Button size="sm" variant={view === "chart" ? "subtle" : "ghost"} aria-pressed={view === "chart"} onClick={() => onViewChange("chart")}>
              <BarChart3 className="h-3.5 w-3.5" aria-hidden /> Chart
            </Button>
            <Button size="sm" variant={view === "table" ? "subtle" : "ghost"} aria-pressed={view === "table"} onClick={() => onViewChange("table")}>
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

      <div className="transition-opacity duration-200" key={view}>
        {view === "chart" ? (
          <ChartErrorBoundary fallback={table}>
            <ChartRenderer spec={spec} rows={rows} />
          </ChartErrorBoundary>
        ) : (
          table
        )}
      </div>

      <Modal open={expanded} onClose={() => setExpanded(false)} title={title}>
        <ChartErrorBoundary fallback={table}>
          <ChartRenderer spec={spec} rows={rows} heightPx={typeof window !== "undefined" && window.innerHeight < 700 ? 360 : 480} />
        </ChartErrorBoundary>
      </Modal>
    </div>
  );
}
