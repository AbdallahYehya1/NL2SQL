"use client";

import { Check, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useReducedMotion } from "@/lib/hooks/use-reduced-motion";
import type { QueryResponse } from "@/lib/types";

/**
 * Maps a real response to { failed, failedStep } for the pipeline's brief transitional visual. Only genuine technical
 * failures count as "failed" — out_of_scope / needs_clarification are the pipeline working correctly, not an error.
 */
export function pipelineOutcomeFor(result: QueryResponse | null): { failed: boolean; failedStep?: number } {
  if (!result || result.success || result.status === "out_of_scope" || result.status === "needs_clarification") return { failed: false };
  switch (result.error?.code) {
    case "SQL_REJECTED":
    case "SQL_GENERATION_FAILED":
      return { failed: true, failedStep: 2 };
    case "SQL_EXECUTION_FAILED":
      return { failed: true, failedStep: 4 };
    default:
      return { failed: true, failedStep: 0 };
  }
}

const STEPS = ["Analyze question", "Retrieve relevant schema", "Generate SQL", "Validate query", "Execute query"];
// Calibrated to roughly how long each real stage tends to take (SQL generation is the LLM call that usually costs the most);
// purely cosmetic pacing — the moment the real response arrives, everything jumps to its final state immediately.
const STEP_AT_MS = [500, 1000, 2600, 3100, 4400];

/**
 * Analyze → Retrieve → Generate → Validate → Execute, animated. This mirrors the pipeline in docs/AI_PIPELINE.md; the
 * timing is an approximation (the API is a single request, not a stream of stage events), but it never delays the
 * real result: as soon as `done` flips true, every remaining step completes (or the current one errors) right away.
 */
/**
 * Mount a fresh instance per question (e.g. `<ProcessingPipeline key={askId} .../>`) so the timers and step both
 * start clean — this component does not reset itself when `done` goes back to false.
 */
export function ProcessingPipeline({ done, failed = false, failedStep }: { done: boolean; failed?: boolean; failedStep?: number }) {
  const reducedMotion = useReducedMotion();
  const [step, setStep] = useState(0);
  const [prevDone, setPrevDone] = useState(done);
  const timers = useRef<ReturnType<typeof setTimeout>[]>([]);

  // React's recommended pattern for "adjust state when a prop changes" (react.dev) — done directly during render
  // rather than in an effect, so the jump-to-complete happens in the same commit the response arrives in. Any
  // already-scheduled step timer that still fires afterwards is harmless: Math.max() below never regresses the step.
  if (done && !prevDone) {
    setPrevDone(done);
    setStep(STEPS.length);
  }

  useEffect(() => {
    if (reducedMotion) return;
    timers.current = STEP_AT_MS.map((ms, i) => setTimeout(() => setStep((s) => Math.max(s, i + 1)), ms));
    return () => timers.current.forEach(clearTimeout);
  }, [reducedMotion]);

  const errorStepIndex = failed ? (failedStep ?? Math.max(0, STEPS.length - 1)) : -1;

  if (reducedMotion) {
    return (
      <div className="flex items-center gap-2 text-sm text-muted-foreground" role="status" aria-live="polite">
        <span className="h-2 w-2 rounded-full bg-primary" aria-hidden />
        {failed ? "The agent hit a problem." : done ? "Done." : "Processing your question…"}
      </div>
    );
  }

  return (
    <ol className="space-y-2.5" aria-label="AI processing" role="status" aria-live="polite">
      {STEPS.map((label, i) => {
        const state = failed && i === errorStepIndex ? "error" : i < step || (done && !failed) ? "done" : i === step ? "active" : "pending";
        return (
          <li
            key={label}
            className="flex animate-step-in items-center gap-2.5 text-sm"
            style={{ animationDelay: `${i * 60}ms` }}
          >
            <span
              className={`flex h-5 w-5 shrink-0 items-center justify-center rounded-full border transition-colors duration-200 ${
                state === "done"
                  ? "border-success bg-success-bg text-success"
                  : state === "active"
                    ? "animate-pulse-soft border-primary bg-accent text-primary"
                    : state === "error"
                      ? "border-danger bg-danger-bg text-danger"
                      : "border-border text-muted-foreground"
              }`}
              aria-hidden
            >
              {state === "done" ? <Check className="h-3 w-3" /> : state === "error" ? <X className="h-3 w-3" /> : <span className="h-1.5 w-1.5 rounded-full bg-current" />}
            </span>
            <span className={state === "pending" ? "text-muted-foreground" : "text-foreground"}>{label}</span>
          </li>
        );
      })}
    </ol>
  );
}
