"use client";

import { Sparkles } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { QueryInput, EXAMPLE_QUESTIONS } from "@/components/query-input/query-input";
import { HistorySidebar, type HistoryItem } from "@/components/sidebar/history-sidebar";
import { SchemaExplorer } from "@/components/sidebar/schema-explorer";
import { DatasetSelector } from "@/components/datasets/dataset-selector";
import { ACTIVE_DATASET_KEY, type DatasetDto } from "@/components/datasets/types";
import { StatusBanner } from "@/components/status-banner";
import { useReducedMotion } from "@/lib/hooks/use-reduced-motion";
import { ProcessingPipeline, pipelineOutcomeFor } from "@/components/results/processing-pipeline";
import { Notice, ResultView } from "@/components/results/result-view";
import type { DetailsTab } from "@/components/results/advanced-details";
import Link from "next/link";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import type { QueryResponse } from "@/lib/types";

export function Dashboard() {
  const [question, setQuestion] = useState("");
  const [asked, setAsked] = useState("");
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<QueryResponse | null>(null);
  const [networkError, setNetworkError] = useState<string | null>(null);
  const [history, setHistory] = useState<HistoryItem[]>([]);
  const [historyLoading, setHistoryLoading] = useState(true);
  const [detailsTab, setDetailsTab] = useState<DetailsTab>("sql");
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [view, setView] = useState<"table" | "chart">("chart");
  const [feedback, setFeedback] = useState<1 | -1 | null>(null);
  const [datasets, setDatasets] = useState<DatasetDto[]>([]);
  const [datasetId, setDatasetId] = useState("demo");
  const [datasetReady, setDatasetReady] = useState(false);
  const [datasetExamples, setDatasetExamples] = useState<{ id: string; list: string[] }>({ id: "demo", list: EXAMPLE_QUESTIONS });
  const examples = datasetId === "demo" ? EXAMPLE_QUESTIONS : datasetExamples.id === datasetId ? datasetExamples.list : [];
  const [showAllHistory, setShowAllHistory] = useState(false);
  const activeDataset = datasets.find((d) => d.id === datasetId);

  const loadHistory = useCallback(async () => {
    try {
      const res = await fetch(`/api/history?datasetId=${showAllHistory ? "all" : encodeURIComponent(datasetId)}`);
      const data = await res.json();
      setHistory(data.runs ?? []);
    } catch {
      /* history is non-critical */
    } finally {
      setHistoryLoading(false);
    }
  }, [datasetId, showAllHistory]);

  // datasets available to this browser (the built-in demo + own uploads) and the initially active one
  useEffect(() => {
    let cancelled = false;
    fetch("/api/datasets")
      .then((r) => r.json())
      .then((d) => {
        if (cancelled) return;
        const list: DatasetDto[] = d.datasets ?? [];
        setDatasets(list);
        let saved: string | null = null;
        try {
          saved = localStorage.getItem(ACTIVE_DATASET_KEY);
        } catch {
          /* storage unavailable */
        }
        const wanted = [saved, d.activeId].find((id) => id && list.some((x) => x.id === id && x.status === "ready"));
        setDatasetId(wanted ?? "demo");
      })
      .catch(() => undefined)
      .finally(() => !cancelled && setDatasetReady(true));
    return () => {
      cancelled = true;
    };
  }, []);

  // history and example questions follow the selected dataset
  useEffect(() => {
    if (!datasetReady) return;
    let cancelled = false;
    fetch(`/api/history?datasetId=${showAllHistory ? "all" : encodeURIComponent(datasetId)}`)
      .then((r) => r.json())
      .then((d) => {
        if (!cancelled) setHistory(d.runs ?? []);
      })
      .catch(() => undefined)
      .finally(() => {
        if (!cancelled) setHistoryLoading(false);
      });
    if (datasetId !== "demo")
      fetch(`/api/datasets/${datasetId}`)
        .then((r) => r.json())
        .then((d) => {
          if (!cancelled) setDatasetExamples({ id: datasetId, list: (d.suggestedQuestions ?? []).slice(0, 5) });
        })
        .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [datasetId, datasetReady, showAllHistory]);

  function changeDataset(id: string) {
    setDatasetId(id);
    setResult(null);
    setNetworkError(null);
    setQuestion("");
    setAsked("");
    setHistoryLoading(true);
    try {
      localStorage.setItem(ACTIVE_DATASET_KEY, id);
    } catch {
      /* storage unavailable */
    }
    void fetch(`/api/datasets/${id}/activate`, { method: "POST" }).catch(() => undefined);
  }

  // A brief hold after the real response arrives so the processing pipeline can show "all done" before the
  // crossfade to the result — never adds to how long the user waits for data, only sequences its reveal.
  const [finishing, setFinishing] = useState(false);
  const [askId, setAskId] = useState(0);
  const reducedMotion = useReducedMotion();

  const ask = useCallback(
    async (q: string) => {
      setLoading(true);
      setFinishing(false);
      setAskId((n) => n + 1);
      setAsked(q);
      setNetworkError(null);
      setFeedback(null);
      setDetailsOpen(false);
      setView("chart");
      try {
        const res = await fetch("/api/query", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ question: q, datasetId }) });
        const data = (await res.json()) as QueryResponse;
        if (data.error?.code === "DATASET_NOT_FOUND" && datasetId !== "demo") {
          // The dataset expired (uploaded data is deleted after 72 hours) or was deleted elsewhere: refresh the list and fall back to the demo.
          const message = "This dataset is no longer available (uploaded datasets are deleted after 72 hours, or when you delete them). Switched back to the demo dataset.";
          setResult({ ...data, answer: message, error: { ...data.error, message } });
          setDatasetId("demo");
          try {
            localStorage.setItem(ACTIVE_DATASET_KEY, "demo");
          } catch {
            /* storage unavailable */
          }
          void fetch("/api/datasets")
            .then((r) => r.json())
            .then((d) => setDatasets(d.datasets ?? []))
            .catch(() => undefined);
        } else {
          setResult(data);
        }
      } catch {
        setResult(null);
        setNetworkError("Could not reach the server. Check your connection and try again.");
      } finally {
        setLoading(false);
        if (reducedMotion) setFinishing(false);
        else {
          setFinishing(true);
          setTimeout(() => setFinishing(false), 350);
        }
        void loadHistory();
      }
    },
    [loadHistory, datasetId, reducedMotion],
  );

  async function sendFeedback(rating: 1 | -1) {
    if (!result?.runId) return;
    setFeedback(rating);
    try {
      await fetch("/api/feedback", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ runId: result.runId, rating }) });
    } catch {
      /* best effort */
    }
  }

  const showProcessing = loading || finishing;
  const pipelineOutcome = pipelineOutcomeFor(result);

  return (
    <div className="mx-auto w-full max-w-6xl flex-1 px-4 py-6 sm:px-6 lg:py-10">
      <header className="mb-8 flex flex-wrap items-end justify-between gap-3">
        <div>
          <div className="flex items-center gap-2 text-primary">
            <Sparkles className="h-5 w-5" aria-hidden />
            <span className="text-xs font-semibold uppercase tracking-widest">Agentic NL2SQL</span>
          </div>
          <h1 className="mt-1 text-2xl font-semibold tracking-tight sm:text-3xl">Ask your database anything</h1>
          <p className="mt-1 max-w-2xl text-sm text-muted-foreground">
            Plain-English questions become validated, read-only SQL. An agent routes the schema, self-corrects failed queries, and shows its work.
          </p>
        </div>
      </header>

      <div className="mb-6 space-y-4">
        <StatusBanner />
        <DatasetSelector datasets={datasets.length ? datasets : [{ id: "demo", name: "E-commerce Demo", sourceType: "builtin", status: "ready", tableCount: 20, columnCount: 0, rowCount: 0, relationshipCount: 0, createdAt: "", isBuiltin: true, pendingRelationships: 0 }]} activeId={datasetId} onChange={changeDataset} disabled={loading} />
      </div>

      <div className="grid gap-6 lg:grid-cols-[280px_minmax(0,1fr)]">
        <aside className="order-2 space-y-4 lg:order-1">
          <HistorySidebar
            items={history}
            loading={historyLoading}
            disabled={loading}
            datasetName={activeDataset?.name}
            showAll={showAllHistory}
            onToggleAll={() => setShowAllHistory((v) => !v)}
            onSelect={(item) => {
              if (item.datasetId && item.datasetId !== datasetId && datasets.some((d) => d.id === item.datasetId && d.status === "ready")) changeDataset(item.datasetId);
              setQuestion(item.question);
              void ask(item.question);
            }}
          />
          <SchemaExplorer datasetId={datasetId} />
        </aside>

        <main className="order-1 min-w-0 space-y-5 lg:order-2">
          <p className="flex flex-wrap items-center gap-2 text-sm" data-testid="querying">
            <span className="text-muted-foreground">Querying:</span>
            <span className="font-semibold">{activeDataset?.name ?? "E-commerce Demo"}</span>
            {activeDataset && !activeDataset.isBuiltin && (
              <Badge tone="neutral">{activeDataset.sourceType === "csv" ? "CSV upload" : "SQL upload"}</Badge>
            )}
            <Link href={`/datasets/${datasetId}`} className="text-xs text-primary underline-offset-2 hover:underline">
              view schema
            </Link>
            <Link href={`/datasets/${datasetId}/dashboard`} className="text-xs text-primary underline-offset-2 hover:underline">
              dashboard
            </Link>
          </p>
          <QueryInput
            value={question}
            onChange={setQuestion}
            onSubmit={(q) => void ask(q)}
            loading={loading}
            examples={examples}
            placeholder={datasetId === "demo" ? undefined : examples[0] ?? "Ask a question about this dataset"}
          />

          <div aria-live="polite" aria-busy={loading}>
            {showProcessing ? (
              <ProcessingCard key={askId} question={asked} done={!loading} failed={pipelineOutcome.failed} failedStep={pipelineOutcome.failedStep} />
            ) : networkError ? (
              <Notice tone="danger" title="Connection problem">
                {networkError}
              </Notice>
            ) : result ? (
              <ResultView
                result={result}
                view={view}
                setView={setView}
                detailsTab={detailsTab}
                setDetailsTab={setDetailsTab}
                detailsOpen={detailsOpen}
                setDetailsOpen={setDetailsOpen}
                feedback={feedback}
                onFeedback={sendFeedback}
                onPick={(q) => {
                  setQuestion(q);
                  void ask(q);
                }}
                originalQuestion={asked}
                examples={examples}
              />
            ) : (
              <EmptyState dataset={activeDataset} examples={examples} />
            )}
          </div>
        </main>
      </div>
    </div>
  );
}

// ───────────────────────── sub-views ─────────────────────────
function EmptyState({ dataset, examples }: { dataset?: DatasetDto; examples: string[] }) {
  return (
    <Card>
      <CardContent className="py-10 text-center">
        <Sparkles className="mx-auto h-8 w-8 text-primary" aria-hidden />
        <h2 className="mt-3 text-base font-semibold">Try a question</h2>
        <p className="mx-auto mt-1 max-w-md text-sm text-muted-foreground">
          {dataset && !dataset.isBuiltin
            ? `${dataset.name}: ${dataset.tableCount} tables, ${dataset.rowCount.toLocaleString("en-US")} rows from your ${dataset.sourceType === "csv" ? "CSV files" : "SQL file"}.`
            : "The demo database is an omnichannel retailer: customers, orders, products, inventory, suppliers, stores, promotions and reviews."}{" "}
          Pick an example above or write your own{examples[0] ? ` — for instance “${examples[0]}”` : ""}.
        </p>
      </CardContent>
    </Card>
  );
}


function ProcessingCard({ question, done, failed, failedStep }: { question: string; done: boolean; failed: boolean; failedStep?: number }) {
  return (
    <Card>
      <CardContent className="space-y-4">
        <p className="text-sm text-muted-foreground">
          <span className="font-medium text-foreground">Working on:</span> “{question}”
        </p>
        <ProcessingPipeline done={done} failed={failed} failedStep={failedStep} />
      </CardContent>
    </Card>
  );
}
