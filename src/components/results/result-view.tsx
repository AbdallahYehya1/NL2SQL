"use client";

import { useMemo } from "react";
import { detectKpi, detectVisualization } from "@/components/charts/detect";
import { ChartView } from "@/components/charts/chart-view";
import { ExecutionTrace } from "@/components/execution-trace/execution-trace";
import { ResultTable } from "@/components/result-table/result-table";
import { Button } from "@/components/ui/button";
import type { QueryResponse } from "@/lib/types";
import { AdvancedDetails, type DetailsTab } from "./advanced-details";
import { InsightCard } from "./insight-card";
import { SupportingInfo } from "./supporting-info";

export function Notice({ tone, title, children }: { tone: "danger" | "warning" | "accent"; title: string; children: React.ReactNode }) {
  const styles = { danger: "border-danger/30 bg-danger-bg text-danger", warning: "border-warning/30 bg-warning-bg text-warning", accent: "border-border bg-card text-foreground" }[tone];
  return (
    <div role={tone === "danger" ? "alert" : "status"} className={`animate-result-in rounded-xl border p-4 ${styles}`}>
      <p className="text-sm font-semibold">{title}</p>
      <div className="mt-1 text-sm">{children}</div>
    </div>
  );
}

function errorTitle(code?: string): string {
  switch (code) {
    case "PROVIDER_NOT_CONFIGURED":
      return "AI provider not configured";
    case "PROVIDER_AUTH":
      return "AI provider rejected the API key";
    case "PROVIDER_RATE_LIMIT":
    case "RATE_LIMITED":
      return "Rate limit reached";
    case "PROVIDER_UNAVAILABLE":
    case "PROVIDER_BAD_OUTPUT":
      return "AI provider problem";
    case "DATABASE_UNAVAILABLE":
      return "Database unavailable";
    case "DATASET_NOT_FOUND":
    case "DATASET_NOT_READY":
      return "Dataset unavailable";
    case "SQL_REJECTED":
      return "Query blocked by the safety validator";
    case "SQL_EXECUTION_FAILED":
      return "Could not produce a working query";
    case "EMPTY_QUESTION":
    case "QUESTION_TOO_LONG":
      return "Check your question";
    default:
      return "Something went wrong";
  }
}

export interface ResultViewProps {
  result: QueryResponse;
  view: "table" | "chart";
  setView: (v: "table" | "chart") => void;
  detailsOpen: boolean;
  setDetailsOpen: (b: boolean) => void;
  detailsTab: DetailsTab;
  setDetailsTab: (t: DetailsTab) => void;
  feedback: 1 | -1 | null;
  onFeedback: (r: 1 | -1) => void;
  onPick: (q: string) => void;
  originalQuestion: string;
  examples: string[];
}

/**
 * Question → AI Insight (answer + KPI) → Visualization (chart/table) → supporting info → advanced details (SQL / trace).
 * The out-of-scope / clarification / error / no-results paths are preserved exactly as before, just restyled.
 */
export function ResultView(p: ResultViewProps) {
  const { result } = p;

  const kpi = useMemo(() => (result.success ? detectKpi(result.columns, result.rows) : undefined), [result]);
  const vizSpec = useMemo(() => (result.success ? detectVisualization(result.columns, result.rows) : undefined), [result]);
  const hasTrace = Boolean(result.trace && (result.trace.attempts.length > 0 || result.trace.routing || result.trace.intent));

  if (result.status === "out_of_scope") {
    return (
      <Notice tone="accent" title="Outside the database domain">
        <p>{result.answer}</p>
        <div className="mt-3 flex flex-wrap gap-2">
          {p.examples.slice(0, 3).map((q) => (
            <Button key={q} variant="outline" size="sm" onClick={() => p.onPick(q)}>
              {q}
            </Button>
          ))}
        </div>
      </Notice>
    );
  }

  if (result.status === "needs_clarification") {
    return (
      <Notice tone="warning" title="I need a bit more detail">
        <p>{result.clarification?.question ?? result.answer}</p>
        {result.clarification && result.clarification.options.length > 0 && (
          <div className="mt-3 flex flex-wrap gap-2">
            {result.clarification.options.map((o) => (
              <Button key={o} variant="outline" size="sm" onClick={() => p.onPick(`${p.originalQuestion} (measure: ${o})`)}>
                {o}
              </Button>
            ))}
          </div>
        )}
      </Notice>
    );
  }

  if (!result.success) {
    return (
      <div className="space-y-4">
        <Notice tone="danger" title={errorTitle(result.error?.code)}>
          {result.answer}
        </Notice>
        {hasTrace && result.attempts > 0 && (
          <div className="rounded-xl border border-border bg-card p-4">
            <h3 className="mb-2 text-sm font-semibold">What the agent tried</h3>
            <ExecutionTrace result={result} />
          </div>
        )}
      </div>
    );
  }

  const noResults = result.status === "no_results";

  return (
    <div className="space-y-6 rounded-2xl border border-border bg-card p-5 sm:p-6">
      <InsightCard answer={result.answer} keyPoints={result.keyPoints} kpi={kpi} runId={result.runId} feedback={p.feedback} onFeedback={p.onFeedback} />

      {!noResults && vizSpec && !(kpi && result.rows.length === 1) && (
        <div className="border-t border-border pt-5">
          {vizSpec.type === "none" || vizSpec.type === "table" ? (
            <div className="space-y-2">
              {vizSpec.type === "table" && !kpi && (
                <p className="text-xs text-muted-foreground">We found the answer, but this result is better represented as a table.</p>
              )}
              <ResultTable columns={result.columns} rows={result.rows} truncated={result.truncated} />
            </div>
          ) : (
            <ChartView
              spec={vizSpec}
              rows={result.rows}
              question={p.originalQuestion}
              view={p.view}
              onViewChange={p.setView}
              table={<ResultTable columns={result.columns} rows={result.rows} truncated={result.truncated} />}
            />
          )}
        </div>
      )}

      <div className="border-t border-border pt-4">
        <SupportingInfo
          datasetName={result.dataset?.name}
          tablesUsed={result.tablesUsed}
          rowCount={result.rowCount}
          truncated={result.truncated}
          columnCount={result.columns.length}
          executionTimeMs={result.executionTimeMs}
          totalLatencyMs={result.totalLatencyMs}
          attempts={result.attempts}
        />
      </div>

      <AdvancedDetails result={result} open={p.detailsOpen} onToggle={() => p.setDetailsOpen(!p.detailsOpen)} tab={p.detailsTab} onTabChange={p.setDetailsTab} />
    </div>
  );
}
