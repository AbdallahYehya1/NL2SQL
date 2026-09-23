"use client";

import { Sparkles } from "lucide-react";
import { useCallback, useState } from "react";
import { QueryInput } from "@/components/query-input/query-input";
import { ProcessingPipeline, pipelineOutcomeFor } from "@/components/results/processing-pipeline";
import { Notice, ResultView } from "@/components/results/result-view";
import type { DetailsTab } from "@/components/results/advanced-details";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { useReducedMotion } from "@/lib/hooks/use-reduced-motion";
import type { QueryResponse } from "@/lib/types";

/**
 * The dashboard's own "Ask this data" — reuses the EXISTING /api/query pipeline and the existing result-rendering
 * components (ProcessingPipeline, ResultView, chart/table toggle, security + rate-limit notices) exactly as the main
 * query page does; this is not a second SQL/answer system, only a second place to reach the same one. Kept as a
 * small self-contained component (rather than extracting a shared hook out of the main page) to avoid touching the
 * existing, already-shipped query flow for an unrelated feature.
 */
export function AskThisData({ datasetId, suggestedQuestions, initialQuestion }: { datasetId: string; suggestedQuestions: string[]; initialQuestion?: string }) {
  const [question, setQuestion] = useState(initialQuestion ?? "");
  const [asked, setAsked] = useState("");
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<QueryResponse | null>(null);
  const [networkError, setNetworkError] = useState<string | null>(null);
  const [detailsTab, setDetailsTab] = useState<DetailsTab>("sql");
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [view, setView] = useState<"table" | "chart">("chart");
  const [feedback, setFeedback] = useState<1 | -1 | null>(null);
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
        setResult((await res.json()) as QueryResponse);
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
      }
    },
    [datasetId, reducedMotion],
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
  const outcome = pipelineOutcomeFor(result);

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Sparkles className="h-4 w-4 text-primary" aria-hidden /> Ask this data
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <QueryInput value={question} onChange={setQuestion} onSubmit={(q) => void ask(q)} loading={loading} examples={suggestedQuestions} placeholder={suggestedQuestions[0] ?? "What would you like to know?"} />
        <div aria-live="polite" aria-busy={loading}>
          {showProcessing ? (
            <Card>
              <CardContent className="space-y-4">
                <p className="text-sm text-muted-foreground">
                  <span className="font-medium text-foreground">Working on:</span> “{asked}”
                </p>
                <ProcessingPipeline key={askId} done={!loading} failed={outcome.failed} failedStep={outcome.failedStep} />
              </CardContent>
            </Card>
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
              examples={suggestedQuestions}
            />
          ) : null}
        </div>
      </CardContent>
    </Card>
  );
}
