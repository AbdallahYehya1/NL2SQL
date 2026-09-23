"use client";

import { Sparkles, ThumbsDown, ThumbsUp } from "lucide-react";
import type { KpiSpec } from "@/components/charts/detect";
import { Button } from "@/components/ui/button";
import { humanizeKeyPoint } from "@/lib/format";
import { KpiBlock } from "./kpi-block";

export function InsightCard({
  answer,
  keyPoints,
  kpi,
  runId,
  feedback,
  onFeedback,
}: {
  answer: string;
  keyPoints: string[];
  kpi?: KpiSpec;
  runId?: string;
  feedback: 1 | -1 | null;
  onFeedback: (r: 1 | -1) => void;
}) {
  return (
    <div className="animate-result-in space-y-4">
      <div className="flex items-start justify-between gap-3">
        <div className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-primary">
          <Sparkles className="h-3.5 w-3.5" aria-hidden />
          AI Insight
        </div>
        {runId && (
          <div className="flex items-center gap-0.5 shrink-0">
            <Button variant="ghost" size="icon" aria-label="Good answer" aria-pressed={feedback === 1} onClick={() => onFeedback(1)}>
              <ThumbsUp className={`h-4 w-4 ${feedback === 1 ? "text-success" : ""}`} aria-hidden />
            </Button>
            <Button variant="ghost" size="icon" aria-label="Bad answer" aria-pressed={feedback === -1} onClick={() => onFeedback(-1)}>
              <ThumbsDown className={`h-4 w-4 ${feedback === -1 ? "text-danger" : ""}`} aria-hidden />
            </Button>
          </div>
        )}
      </div>

      <p className="text-lg font-medium leading-relaxed text-foreground sm:text-xl">{answer}</p>

      {keyPoints.length > 0 && (
        <ul className="space-y-1 text-sm text-muted-foreground">
          {keyPoints.map((k) => (
            <li key={k} className="flex gap-2">
              <span className="mt-2 h-1 w-1 shrink-0 rounded-full bg-muted-foreground" aria-hidden />
              {humanizeKeyPoint(k)}
            </li>
          ))}
        </ul>
      )}

      {kpi && <KpiBlock kpi={kpi} />}
    </div>
  );
}
