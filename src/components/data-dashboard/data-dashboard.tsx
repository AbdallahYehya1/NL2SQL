"use client";

import { RefreshCw } from "lucide-react";
import { useEffect, useState } from "react";
import { Notice } from "@/components/results/result-view";
import { Button } from "@/components/ui/button";
import type { DashboardData } from "@/lib/dashboard/types";
import { AskTeaser } from "./ask-teaser";
import { DashboardSkeleton } from "./dashboard-skeleton";
import { DashboardTabBar, useDashboardTabs } from "./dashboard-tabs";
import { DataQualityCard } from "./data-quality-card";
import { DatasetHeader } from "./dataset-header";
import { InsightList } from "./insight-list";
import { KpiGrid } from "./kpi-grid";
import { RelationshipGraph } from "./relationship-graph";
import { SummarySection } from "./summary-section";
import { VisualizationSection } from "./visualization-section";

/**
 * Dataset-aware Data Dashboard: fetches the fully server-computed, deterministic DashboardData (see
 * src/lib/dashboard/engine.ts) and lays it out. This component contains no analytics of its own — every number
 * shown here was already verified server-side; the component only formats and arranges it.
 */
export function DataDashboard({ id }: { id: string }) {
  const [data, setData] = useState<DashboardData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [reloadToken, setReloadToken] = useState(0);
  const [prevReloadToken, setPrevReloadToken] = useState(reloadToken);
  const [tab, setTab] = useDashboardTabs();

  // A retry (reloadToken change) resets to the loading state during render, not inside the effect below — the
  // effect itself must not call setState synchronously (see use-countdown.ts / processing-pipeline.tsx for the
  // same pattern elsewhere in this codebase).
  if (reloadToken !== prevReloadToken) {
    setPrevReloadToken(reloadToken);
    setLoading(true);
    setError(null);
  }

  // Inline fetch (not a separately-called async function) — every setState call below lives inside a .then()/.catch()
  // continuation, matching dataset-details.tsx's established pattern, so none of it runs synchronously within the effect.
  useEffect(() => {
    let cancelled = false;
    fetch(`/api/datasets/${id}/dashboard`)
      .then(async (res) => {
        const body = await res.json();
        if (cancelled) return;
        if (!res.ok) {
          setError(body.error ?? "Could not load the dashboard for this dataset.");
          setData(null);
        } else {
          setData(body as DashboardData);
        }
      })
      .catch(() => {
        if (cancelled) return;
        setError("Could not reach the server. Check your connection and try again.");
        setData(null);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [id, reloadToken]);

  return (
    <div className="mx-auto w-full max-w-6xl flex-1 space-y-5 px-4 py-6 sm:px-6 lg:py-10">
      {loading ? (
        <DashboardSkeleton />
      ) : error || !data ? (
        <Notice tone="danger" title="Dashboard unavailable">
          <p>{error ?? "Something went wrong."}</p>
          <p className="mt-2 text-xs">Your dataset itself is still available — you can still ask it questions from the main page.</p>
        </Notice>
      ) : (
        <>
          <div className="flex flex-wrap items-start justify-between gap-3">
            <DatasetHeader data={data} />
            <Button variant="outline" size="sm" onClick={() => setReloadToken((n) => n + 1)}>
              <RefreshCw className="h-3.5 w-3.5" aria-hidden /> Refresh
            </Button>
          </div>
          {data.warnings.length > 0 && (
            <Notice tone="warning" title="Some dashboard insights couldn't be generated">
              <p>Your dataset is still available and you can continue asking questions below.</p>
            </Notice>
          )}

          <DashboardTabBar active={tab} onChange={setTab} badges={{ insights: data.insights.length, analytics: data.visualizations.length }} />

          {tab === "overview" && (
            <div className="animate-result-in space-y-5">
              <KpiGrid kpis={data.kpis} />
              <SummarySection data={data} onRetry={() => setReloadToken((n) => n + 1)} />
              {data.visualizations[0] && <VisualizationSection visualizations={data.visualizations.slice(0, 1)} />}
              {data.insights.length > 0 && <InsightList insights={data.insights.slice(0, 2)} />}
              <AskTeaser datasetId={data.datasetId} suggestedQuestions={data.suggestedQuestions} />
            </div>
          )}
          {tab === "analytics" &&
            (data.visualizations.length > 0 ? (
              <div className="animate-result-in">
                <VisualizationSection visualizations={data.visualizations} />
              </div>
            ) : (
              <Notice tone="accent" title="Not enough data for a visualization">
                This dataset does not yet have a combination of columns (a date, a category, or two numeric fields) that produces a meaningful chart. Try asking a question instead.
              </Notice>
            ))}
          {tab === "insights" && (
            <div className="animate-result-in">
              {data.insights.length > 0 ? <InsightList insights={data.insights} /> : <Notice tone="accent" title="No standout findings yet">This dataset does not yet have a strong enough trend, comparison, or concentration to report — the KPIs above still reflect the real data.</Notice>}
            </div>
          )}
          {tab === "quality" && (
            <div className="animate-result-in">
              <DataQualityCard quality={data.quality} />
            </div>
          )}
          {tab === "relationships" && (
            <div className="animate-result-in">
              <RelationshipGraph relationships={data.relationships} />
            </div>
          )}
        </>
      )}
    </div>
  );
}
