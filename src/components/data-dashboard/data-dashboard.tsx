"use client";

import { ArrowLeft } from "lucide-react";
import Link from "next/link";
import { useEffect, useState } from "react";
import { Notice } from "@/components/results/result-view";
import type { DashboardData } from "@/lib/dashboard/types";
import { AskThisData } from "./ask-this-data";
import { DashboardSkeleton } from "./dashboard-skeleton";
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
      <Link href={`/datasets/${id}`} className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground">
        <ArrowLeft className="h-4 w-4" aria-hidden /> Dataset details
      </Link>

      {loading ? (
        <DashboardSkeleton />
      ) : error || !data ? (
        <Notice tone="danger" title="Dashboard unavailable">
          <p>{error ?? "Something went wrong."}</p>
          <p className="mt-2 text-xs">Your dataset itself is still available — you can still ask it questions from the main page.</p>
        </Notice>
      ) : (
        <>
          <DatasetHeader data={data} />
          <KpiGrid kpis={data.kpis} />
          <SummarySection data={data} onRetry={() => setReloadToken((n) => n + 1)} />
          {data.warnings.length > 0 && (
            <Notice tone="warning" title="Some dashboard insights couldn't be generated">
              <p>Your dataset is still available and you can continue asking questions below.</p>
            </Notice>
          )}
          <VisualizationSection visualizations={data.visualizations} />
          <InsightList insights={data.insights} />
          <div className="grid gap-4 lg:grid-cols-2">
            <RelationshipGraph relationships={data.relationships} />
            <DataQualityCard quality={data.quality} />
          </div>
          <AskThisData datasetId={data.datasetId} suggestedQuestions={data.suggestedQuestions} />
        </>
      )}
    </div>
  );
}
