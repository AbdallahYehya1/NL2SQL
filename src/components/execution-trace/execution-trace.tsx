"use client";

import { CheckCircle2, CircleAlert, CircleDashed, Wrench } from "lucide-react";
import type { ReactNode } from "react";
import { Badge } from "@/components/ui/badge";
import { SqlViewer } from "@/components/sql-viewer/sql-viewer";
import type { QueryResponse } from "@/lib/types";

function Step({ n, title, meta, children }: { n: number; title: string; meta?: ReactNode; children?: ReactNode }) {
  return (
    <li className="relative pl-9">
      <span className="absolute left-0 top-0 flex h-6 w-6 items-center justify-center rounded-full bg-accent text-xs font-semibold text-accent-foreground" aria-hidden>
        {n}
      </span>
      <div className="flex flex-wrap items-center gap-2">
        <h3 className="text-sm font-semibold">{title}</h3>
        {meta}
      </div>
      {children ? <div className="mt-2 space-y-2 text-sm text-muted-foreground">{children}</div> : null}
    </li>
  );
}

const chips = (items: string[], tone: "accent" | "neutral" = "neutral") =>
  items.map((t) => (
    <Badge key={t} tone={tone} className="font-mono">
      {t}
    </Badge>
  ));

export function ExecutionTrace({ result }: { result: QueryResponse }) {
  const t = result.trace;
  const ms = (stage: string) => t.timings.find((x) => x.stage === stage)?.ms;
  let n = 0;

  return (
    <ol className="space-y-5" aria-label="Agent execution trace">
      {t.intent ? (
        <Step n={++n} title="Question analysis" meta={<Badge>{t.intent.source === "llm" ? "rules + LLM" : "rules"}</Badge>}>
          <p>
            Type: <strong className="text-foreground">{t.intent.queryType}</strong> · In scope: <strong className="text-foreground">{t.intent.inScope ? "yes" : "no"}</strong>
            {t.intent.timeRange ? <> · Period: <strong className="text-foreground">{t.intent.timeRange}</strong></> : null}
          </p>
          {t.intent.concepts.length > 0 && <div className="flex flex-wrap gap-1.5">{chips(t.intent.concepts, "accent")}</div>}
          {t.intent.assumptions.length > 0 && (
            <ul className="list-inside list-disc">
              {t.intent.assumptions.map((a) => (
                <li key={a}>Assumption: {a}</li>
              ))}
            </ul>
          )}
          {!t.intent.inScope && t.intent.scopeReason && <p>Reason: {t.intent.scopeReason}</p>}
        </Step>
      ) : null}

      {t.routing ? (
        <Step
          n={++n}
          title="Semantic routing & metadata retrieval"
          meta={
            <>
              <Badge tone={t.routing.method === "hybrid" ? "success" : "neutral"}>{t.routing.method === "hybrid" ? "hybrid: lexical + vector" : "lexical"}</Badge>
              {ms("retrieval") !== undefined && <span className="text-xs">{ms("retrieval")} ms</span>}
            </>
          }
        >
          {t.routing.vectorUnavailableReason && <p className="text-xs">Vector search skipped: {t.routing.vectorUnavailableReason}.</p>}
          <div className="space-y-1">
            {t.routing.tableScores.slice(0, 6).map((s) => {
              const selected = t.routing!.selectedTables.includes(s.table);
              return (
                <div key={s.table} className="flex items-center gap-2 text-xs">
                  <span className={`w-40 shrink-0 truncate font-mono ${selected ? "text-foreground" : ""}`}>{s.table}</span>
                  <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-muted" role="presentation">
                    <div className={`h-full rounded-full ${selected ? "bg-primary" : "bg-muted-foreground/40"}`} style={{ width: `${Math.round(s.score * 100)}%` }} />
                  </div>
                  <span className="w-9 text-right tabular-nums">{s.score.toFixed(2)}</span>
                </div>
              );
            })}
          </div>
          <p>
            Selected: {chips(t.routing.selectedTables, "accent")}
            {t.routing.bridgeTables.length > 0 && <> · Join bridges: {chips(t.routing.bridgeTables)}</>}
          </p>
          {t.routing.matchedMetrics.length > 0 && <p>Business metrics matched: {chips(t.routing.matchedMetrics)}</p>}
        </Step>
      ) : null}

      {t.subSchema ? (
        <Step n={++n} title="Sub-schema" meta={<Badge>{t.subSchema.tables.length} of 20 tables · {t.subSchema.columns.length} columns</Badge>}>
          <p>Only this reduced schema (not the whole database) was sent to the SQL generator.</p>
          {t.subSchema.relationships.length > 0 && (
            <ul className="space-y-0.5 font-mono text-xs">
              {t.subSchema.relationships.map((r) => (
                <li key={r}>{r}</li>
              ))}
            </ul>
          )}
        </Step>
      ) : null}

      {t.attempts.length > 0 ? (
        <Step n={++n} title="SQL generation, validation & execution" meta={<Badge tone={result.attempts > 1 ? "warning" : "neutral"}>{result.attempts} attempt{result.attempts === 1 ? "" : "s"}</Badge>}>
          <ol className="space-y-3">
            {t.attempts.map((a) => {
              const correction = result.corrections.find((c) => c.attempt === a.attempt);
              const failed = !a.validation.valid || (a.execution && !a.execution.success);
              return (
                <li key={a.attempt} className="rounded-lg border border-border p-3">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-xs font-semibold text-foreground">Attempt {a.attempt}</span>
                    <Badge tone={a.validation.valid ? "success" : "danger"}>
                      {a.validation.valid ? <CheckCircle2 className="h-3 w-3" aria-hidden /> : <CircleAlert className="h-3 w-3" aria-hidden />}
                      validation {a.validation.valid ? "passed" : "failed"}
                    </Badge>
                    {a.execution ? (
                      <Badge tone={a.execution.success ? "success" : "danger"}>
                        {a.execution.success ? <CheckCircle2 className="h-3 w-3" aria-hidden /> : <CircleAlert className="h-3 w-3" aria-hidden />}
                        {a.execution.success ? `executed · ${a.execution.rowCount} rows · ${a.execution.executionTimeMs} ms` : "execution failed"}
                      </Badge>
                    ) : (
                      <Badge tone="neutral">
                        <CircleDashed className="h-3 w-3" aria-hidden /> not executed
                      </Badge>
                    )}
                  </div>
                  {!a.validation.valid && (
                    <ul className="mt-2 list-inside list-disc text-xs text-danger">
                      {a.validation.issues.map((i, idx) => (
                        <li key={idx}>
                          <span className="font-mono">{i.code}</span>: {i.message}
                        </li>
                      ))}
                    </ul>
                  )}
                  {a.execution && !a.execution.success && a.execution.error && (
                    <p className="mt-2 text-xs text-danger">
                      <span className="font-mono">{a.execution.error.code}</span>: {a.execution.error.message}
                    </p>
                  )}
                  <details className="mt-2" open={Boolean(failed)}>
                    <summary className="cursor-pointer text-xs text-primary">View SQL</summary>
                    <div className="mt-2">
                      <SqlViewer sql={a.sql} label={`Attempt ${a.attempt}`} />
                    </div>
                  </details>
                  {correction?.diagnosis && (
                    <div className="mt-3 rounded-md bg-warning-bg p-2.5 text-xs text-warning">
                      <div className="mb-1 flex items-center gap-1.5 font-semibold">
                        <Wrench className="h-3.5 w-3.5" aria-hidden /> Self-correction
                      </div>
                      <p>
                        <strong>Diagnosis:</strong> {correction.diagnosis}
                      </p>
                      {correction.outcome && <p className="mt-1">Result of corrected query: {correction.outcome}</p>}
                    </div>
                  )}
                </li>
              );
            })}
          </ol>
        </Step>
      ) : null}

      {t.llmCalls.length > 0 ? (
        <Step n={++n} title="Model calls" meta={<span className="text-xs">{t.provider} · {t.model}</span>}>
          <table className="w-full text-xs">
            <thead>
              <tr className="text-left">
                <th className="pb-1 font-medium">Purpose</th>
                <th className="pb-1 font-medium">Latency</th>
                <th className="pb-1 font-medium">Status</th>
              </tr>
            </thead>
            <tbody>
              {t.llmCalls.map((c, i) => (
                <tr key={i} className="border-t border-border">
                  <td className="py-1 font-mono">{c.purpose}</td>
                  <td className="py-1 tabular-nums">{c.latencyMs} ms</td>
                  <td className="py-1">{c.ok ? "ok" : `fallback used (${c.error ?? "failed"})`}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="text-xs">Total latency: {result.totalLatencyMs} ms</p>
        </Step>
      ) : null}
    </ol>
  );
}
