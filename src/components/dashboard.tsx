"use client";

import dynamic from "next/dynamic";
import { BarChart3, Clock, Code2, GitBranch, Sparkles, Table2, ThumbsDown, ThumbsUp, Wrench } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { detectChart } from "@/components/charts/auto-chart";
import { ExecutionTrace } from "@/components/execution-trace/execution-trace";
import { QueryInput, EXAMPLE_QUESTIONS } from "@/components/query-input/query-input";
import { ResultTable } from "@/components/result-table/result-table";
import { HistorySidebar, type HistoryItem } from "@/components/sidebar/history-sidebar";
import { SchemaExplorer } from "@/components/sidebar/schema-explorer";
import { SqlViewer } from "@/components/sql-viewer/sql-viewer";
import { DatasetSelector } from "@/components/datasets/dataset-selector";
import { ACTIVE_DATASET_KEY, type DatasetDto } from "@/components/datasets/types";
import { StatusBanner } from "@/components/status-banner";
import Link from "next/link";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import type { QueryResponse } from "@/lib/types";

const AutoChart = dynamic(() => import("@/components/charts/auto-chart").then((m) => m.AutoChart), {
  ssr: false,
  loading: () => <Skeleton className="h-72" />,
});

type Tab = "sql" | "trace";

export function Dashboard() {
  const [question, setQuestion] = useState("");
  const [asked, setAsked] = useState("");
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<QueryResponse | null>(null);
  const [networkError, setNetworkError] = useState<string | null>(null);
  const [history, setHistory] = useState<HistoryItem[]>([]);
  const [historyLoading, setHistoryLoading] = useState(true);
  const [tab, setTab] = useState<Tab>("sql");
  const [showDetails, setShowDetails] = useState(false);
  const [view, setView] = useState<"table" | "chart">("table");
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

  const ask = useCallback(
    async (q: string) => {
      setLoading(true);
      setAsked(q);
      setNetworkError(null);
      setFeedback(null);
      setShowDetails(false);
      setView("table");
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
        void loadHistory();
      }
    },
    [loadHistory, datasetId],
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

  const chartSpec = useMemo(() => (result?.success ? detectChart(result.columns, result.rows) : undefined), [result]);
  const hasTrace = result && result.trace && (result.trace.attempts.length > 0 || result.trace.routing || result.trace.intent);

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
            {loading ? (
              <LoadingState question={asked} />
            ) : networkError ? (
              <Notice tone="danger" title="Connection problem">
                {networkError}
              </Notice>
            ) : result ? (
              <ResultView
                result={result}
                chartSpec={chartSpec}
                view={view}
                setView={setView}
                tab={tab}
                setTab={setTab}
                showDetails={showDetails}
                setShowDetails={setShowDetails}
                hasTrace={Boolean(hasTrace)}
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

function LoadingState({ question }: { question: string }) {
  return (
    <div className="space-y-4">
      <Card>
        <CardContent className="space-y-3">
          <p className="text-sm text-muted-foreground">
            <span className="font-medium text-foreground">Working on:</span> “{question}”
          </p>
          <p className="text-xs text-muted-foreground">Analyzing the question, routing the schema, generating and validating SQL, then running it read-only…</p>
          <Skeleton className="h-5 w-3/4" />
          <Skeleton className="h-5 w-1/2" />
        </CardContent>
      </Card>
      <Card>
        <CardContent className="space-y-2">
          <Skeleton className="h-8" />
          <Skeleton className="h-6" />
          <Skeleton className="h-6" />
          <Skeleton className="h-6" />
        </CardContent>
      </Card>
    </div>
  );
}

function Notice({ tone, title, children }: { tone: "danger" | "warning" | "accent"; title: string; children: React.ReactNode }) {
  const styles = { danger: "border-danger/30 bg-danger-bg text-danger", warning: "border-warning/30 bg-warning-bg text-warning", accent: "border-border bg-card text-foreground" }[tone];
  return (
    <div role={tone === "danger" ? "alert" : "status"} className={`rounded-xl border p-4 ${styles}`}>
      <p className="text-sm font-semibold">{title}</p>
      <div className="mt-1 text-sm">{children}</div>
    </div>
  );
}

interface ResultViewProps {
  result: QueryResponse;
  chartSpec: ReturnType<typeof detectChart>;
  view: "table" | "chart";
  setView: (v: "table" | "chart") => void;
  tab: Tab;
  setTab: (t: Tab) => void;
  showDetails: boolean;
  setShowDetails: (b: boolean) => void;
  hasTrace: boolean;
  feedback: 1 | -1 | null;
  onFeedback: (r: 1 | -1) => void;
  onPick: (q: string) => void;
  originalQuestion: string;
  examples: string[];
}

function ResultView(p: ResultViewProps) {
  const { result } = p;

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
        {p.hasTrace && result.attempts > 0 && (
          <Card>
            <CardHeader>
              <CardTitle>What the agent tried</CardTitle>
            </CardHeader>
            <CardContent>
              <ExecutionTrace result={result} />
            </CardContent>
          </Card>
        )}
      </div>
    );
  }

  const noResults = result.status === "no_results";
  return (
    <div className="space-y-5">
      <Card>
        <CardHeader>
          <CardTitle>Answer</CardTitle>
          <div className="flex items-center gap-1">
            {result.runId && (
              <>
                <Button variant="ghost" size="icon" aria-label="Good answer" aria-pressed={p.feedback === 1} onClick={() => p.onFeedback(1)}>
                  <ThumbsUp className={`h-4 w-4 ${p.feedback === 1 ? "text-success" : ""}`} aria-hidden />
                </Button>
                <Button variant="ghost" size="icon" aria-label="Bad answer" aria-pressed={p.feedback === -1} onClick={() => p.onFeedback(-1)}>
                  <ThumbsDown className={`h-4 w-4 ${p.feedback === -1 ? "text-danger" : ""}`} aria-hidden />
                </Button>
              </>
            )}
          </div>
        </CardHeader>
        <CardContent className="space-y-3">
          <p className="text-base leading-relaxed">{result.answer}</p>
          {result.keyPoints.length > 0 && (
            <ul className="list-inside list-disc space-y-0.5 text-sm text-muted-foreground">
              {result.keyPoints.map((k) => (
                <li key={k}>{k}</li>
              ))}
            </ul>
          )}
          <div className="flex flex-wrap items-center gap-2 pt-1 text-xs">
            {result.dataset && (
              <Badge tone="neutral">
                Dataset: {result.dataset.name}
              </Badge>
            )}
            {result.tablesUsed.length > 0 && (
              <span className="flex flex-wrap items-center gap-1.5">
                <span className="text-muted-foreground">Tables used:</span>
                {result.tablesUsed.map((t) => (
                  <Badge key={t} tone="accent" className="font-mono">
                    {t}
                  </Badge>
                ))}
              </span>
            )}
            {result.executionTimeMs !== undefined && (
              <Badge>
                <Clock className="h-3 w-3" aria-hidden /> {result.executionTimeMs} ms query · {result.totalLatencyMs} ms total
              </Badge>
            )}
            {result.attempts > 1 && (
              <Badge tone="warning">
                <Wrench className="h-3 w-3" aria-hidden /> self-corrected in {result.attempts} attempts
              </Badge>
            )}
          </div>
        </CardContent>
      </Card>

      {!noResults && (
        <Card>
          <CardHeader>
            <CardTitle>Results</CardTitle>
            {p.chartSpec && (
              <div className="flex rounded-lg border border-border p-0.5" role="group" aria-label="Result view">
                <Button size="sm" variant={p.view === "table" ? "subtle" : "ghost"} aria-pressed={p.view === "table"} onClick={() => p.setView("table")}>
                  <Table2 className="h-3.5 w-3.5" aria-hidden /> Table
                </Button>
                <Button size="sm" variant={p.view === "chart" ? "subtle" : "ghost"} aria-pressed={p.view === "chart"} onClick={() => p.setView("chart")}>
                  <BarChart3 className="h-3.5 w-3.5" aria-hidden /> Chart
                </Button>
              </div>
            )}
          </CardHeader>
          <CardContent>
            {p.view === "chart" && p.chartSpec ? <AutoChart spec={p.chartSpec} rows={result.rows} /> : <ResultTable columns={result.columns} rows={result.rows} truncated={result.truncated} />}
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader>
          <CardTitle>Query details</CardTitle>
          <Button variant="outline" size="sm" aria-expanded={p.showDetails} onClick={() => p.setShowDetails(!p.showDetails)}>
            <Code2 className="h-3.5 w-3.5" aria-hidden /> {p.showDetails ? "Hide SQL" : "Show SQL"}
          </Button>
        </CardHeader>
        <CardContent className="space-y-4">
          <dl className="grid grid-cols-2 gap-3 text-sm sm:grid-cols-4">
            <Metric label="Tables selected" value={String(result.trace.subSchema?.tables.length ?? result.tablesUsed.length)} />
            <Metric label="Attempts" value={String(result.attempts)} />
            <Metric label="Rows" value={`${result.rowCount}${result.truncated ? "+" : ""}`} />
            <Metric label="Retrieval" value={result.trace.routing?.method === "hybrid" ? "hybrid" : "lexical"} />
          </dl>
          {p.showDetails && (
            <div className="space-y-3">
              <div role="tablist" aria-label="Details" className="flex gap-1 border-b border-border">
                <TabButton active={p.tab === "sql"} onClick={() => p.setTab("sql")} icon={<Code2 className="h-3.5 w-3.5" aria-hidden />}>
                  SQL
                </TabButton>
                <TabButton active={p.tab === "trace"} onClick={() => p.setTab("trace")} icon={<GitBranch className="h-3.5 w-3.5" aria-hidden />}>
                  Agent trace
                </TabButton>
              </div>
              {p.tab === "sql" && result.sql && (
                <div className="space-y-2">
                  <SqlViewer sql={result.sql} />
                  {result.explanation && <p className="text-sm text-muted-foreground">{result.explanation}</p>}
                  {result.columnsUsed.length > 0 && (
                    <p className="flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
                      Columns used:{" "}
                      {result.columnsUsed.map((c) => (
                        <Badge key={c} className="font-mono">
                          {c}
                        </Badge>
                      ))}
                    </p>
                  )}
                </div>
              )}
              {p.tab === "trace" && <ExecutionTrace result={result} />}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="text-lg font-semibold tabular-nums">{value}</dd>
    </div>
  );
}

function TabButton({ active, onClick, icon, children }: { active: boolean; onClick: () => void; icon: React.ReactNode; children: React.ReactNode }) {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={active}
      onClick={onClick}
      className={`-mb-px flex items-center gap-1.5 border-b-2 px-3 py-2 text-sm ${active ? "border-primary font-medium text-foreground" : "border-transparent text-muted-foreground hover:text-foreground"}`}
    >
      {icon}
      {children}
    </button>
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
