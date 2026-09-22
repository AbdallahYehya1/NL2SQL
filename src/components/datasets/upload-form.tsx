"use client";

import { CheckCircle2, CircleAlert, FileText, Loader2, Upload, X } from "lucide-react";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useId, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { PrivacyNotice } from "./privacy-notice";
import type { DatasetDto, UploadLimitsDto } from "./types";

type StepId = "parse" | "tables" | "columns" | "load" | "relationships" | "metadata" | "embeddings";
type StepState = { status: "pending" | "running" | "done" | "skipped"; detail?: string };

const STEPS: { id: StepId; label: string }[] = [
  { id: "parse", label: "Parsing files" },
  { id: "tables", label: "Detecting tables" },
  { id: "columns", label: "Detecting columns" },
  { id: "load", label: "Loading data into an isolated schema" },
  { id: "relationships", label: "Detecting relationships" },
  { id: "metadata", label: "Building metadata" },
  { id: "embeddings", label: "Creating embeddings (optional)" },
];

const emptySteps = (): Record<StepId, StepState> => Object.fromEntries(STEPS.map((s) => [s.id, { status: "pending" }])) as Record<StepId, StepState>;

const kb = (n: number) => (n < 1024 * 1024 ? `${Math.max(1, Math.round(n / 1024))} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`);
const ext = (f: File) => f.name.toLowerCase().split(".").pop();

export function UploadForm() {
  const router = useRouter();
  const inputId = useId();
  const nameId = useId();
  const fileInput = useRef<HTMLInputElement>(null);
  const [files, setFiles] = useState<File[]>([]);
  const [name, setName] = useState("");
  const [describe, setDescribe] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [busy, setBusy] = useState(false);
  const [steps, setSteps] = useState<Record<StepId, StepState>>(emptySteps);
  const [failure, setFailure] = useState<{ message: string; details: string[] } | null>(null);
  const [done, setDone] = useState<DatasetDto | null>(null);
  const [limits, setLimits] = useState<UploadLimitsDto | undefined>();

  useEffect(() => {
    fetch("/api/datasets")
      .then((r) => r.json())
      .then((d) => setLimits(d.limits))
      .catch(() => undefined);
  }, []);

  const problem = (() => {
    if (files.length === 0) return null;
    const sql = files.filter((f) => ext(f) === "sql").length;
    const csv = files.filter((f) => ext(f) === "csv").length;
    if (sql + csv !== files.length) return "Only .sql and .csv files are supported.";
    if (sql && csv) return "Upload either one .sql file or CSV files — not both.";
    if (sql > 1) return "Upload a single .sql file per dataset.";
    if (limits && files.length > limits.maxFiles) return `At most ${limits.maxFiles} files.`;
    if (limits && files.reduce((n, f) => n + f.size, 0) > limits.maxRequestMb * 1024 * 1024) return `The files together may be at most ${limits.maxRequestMb} MB.`;
    if (limits && files.some((f) => ext(f) === "csv" && f.size > limits.maxCsvMb * 1024 * 1024)) return `Each CSV file may be at most ${limits.maxCsvMb} MB.`;
    return null;
  })();

  const addFiles = useCallback((list: FileList | File[]) => {
    const incoming = Array.from(list);
    setFiles((prev) => {
      const next = [...prev, ...incoming.filter((f) => !prev.some((p) => p.name === f.name && p.size === f.size))];
      return next;
    });
    setName((n) => n || (incoming.length > 1 ? "CSV dataset" : (incoming[0]?.name.replace(/\.[^.]+$/, "").replace(/[_-]+/g, " ") ?? "")));
  }, []);

  async function submit() {
    setBusy(true);
    setFailure(null);
    setDone(null);
    setSteps(emptySteps());
    const form = new FormData();
    files.forEach((f) => form.append("files", f));
    form.append("name", name);
    form.append("describe", String(describe));
    try {
      const res = await fetch("/api/datasets/upload", { method: "POST", body: form });
      if (!res.body || !(res.headers.get("content-type") ?? "").includes("ndjson")) {
        const data = await res.json().catch(() => ({}));
        setFailure({ message: data.error ?? "The upload was rejected.", details: [] });
        return;
      }
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      for (;;) {
        const { value, done: finished } = await reader.read();
        if (finished) break;
        buffer += decoder.decode(value, { stream: true });
        let nl: number;
        while ((nl = buffer.indexOf("\n")) >= 0) {
          const line = buffer.slice(0, nl).trim();
          buffer = buffer.slice(nl + 1);
          if (!line) continue;
          const ev = JSON.parse(line);
          if (ev.type === "progress") setSteps((s) => ({ ...s, [ev.step as StepId]: { status: ev.status, detail: ev.detail } }));
          else if (ev.type === "done") setDone(ev.dataset as DatasetDto);
          else if (ev.type === "error") setFailure({ message: ev.message, details: ev.details ?? [] });
        }
      }
    } catch {
      setFailure({ message: "The upload could not be completed. Check your connection and try again.", details: [] });
    } finally {
      setBusy(false);
    }
  }

  const started = busy || done || failure;

  return (
    <div className="space-y-5">
      <PrivacyNotice limits={limits} />
      <Card>
        <CardHeader>
          <CardTitle>Add a dataset</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div
            onDragOver={(e) => {
              e.preventDefault();
              setDragging(true);
            }}
            onDragLeave={() => setDragging(false)}
            onDrop={(e) => {
              e.preventDefault();
              setDragging(false);
              addFiles(e.dataTransfer.files);
            }}
            className={`flex flex-col items-center gap-2 rounded-xl border-2 border-dashed p-8 text-center transition-colors ${dragging ? "border-primary bg-accent" : "border-border"}`}
          >
            <Upload className="h-8 w-8 text-muted-foreground" aria-hidden />
            <p className="text-sm font-medium">Drop files here</p>
            <p className="text-xs text-muted-foreground">
              One <code>.sql</code> file (CREATE TABLE + INSERT) or one or more <code>.csv</code> files
            </p>
            <input ref={fileInput} id={inputId} type="file" multiple accept=".sql,.csv,text/csv" className="sr-only" onChange={(e) => e.target.files && addFiles(e.target.files)} />
            <Button type="button" variant="outline" size="sm" onClick={() => fileInput.current?.click()} disabled={busy}>
              Choose files
            </Button>
          </div>

          {limits && (
            <p className="text-xs text-muted-foreground">
              Limits: up to {limits.maxFiles} files · {limits.maxRequestMb} MB total ({limits.maxCsvMb} MB per CSV) · {limits.maxTables} tables · {limits.maxColumnsPerTable} columns per table ·{" "}
              {limits.maxRows.toLocaleString("en-US")} rows in total · {limits.maxDatasetsPerSession} datasets per browser.
            </p>
          )}

          {files.length > 0 && (
            <ul className="divide-y divide-border rounded-lg border border-border text-sm">
              {files.map((f) => (
                <li key={`${f.name}-${f.size}`} className="flex items-center gap-2 px-3 py-2">
                  <FileText className="h-4 w-4 text-muted-foreground" aria-hidden />
                  <span className="min-w-0 flex-1 truncate">{f.name}</span>
                  <span className="text-xs text-muted-foreground">{kb(f.size)}</span>
                  <button type="button" disabled={busy} onClick={() => setFiles((p) => p.filter((x) => x !== f))} aria-label={`Remove ${f.name}`} className="rounded p-1 hover:bg-muted disabled:opacity-40">
                    <X className="h-4 w-4" aria-hidden />
                  </button>
                </li>
              ))}
            </ul>
          )}
          {problem && (
            <p role="alert" className="text-sm text-danger">
              {problem}
            </p>
          )}

          <div className="grid gap-3 sm:grid-cols-[1fr_auto] sm:items-end">
            <div>
              <label htmlFor={nameId} className="mb-1 block text-sm font-medium">
                Dataset name
              </label>
              <input id={nameId} value={name} onChange={(e) => setName(e.target.value)} maxLength={60} placeholder="e.g. Company HR" disabled={busy} className="h-10 w-full rounded-lg border border-border bg-card px-3 text-sm" />
            </div>
          </div>

          <label className="flex items-start gap-2 text-sm">
            <input type="checkbox" checked={describe} onChange={(e) => setDescribe(e.target.checked)} disabled={busy} className="mt-1" />
            <span>
              Write table and column descriptions with the AI model
              <span className="block text-xs text-muted-foreground">Optional. Sends only table/column names and types — never your rows. Generated text is labelled as AI-generated and never changes the real structure.</span>
            </span>
          </label>

          <div className="flex justify-end">
            <Button type="button" onClick={submit} disabled={busy || files.length === 0 || Boolean(problem)}>
              {busy ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : <Upload className="h-4 w-4" aria-hidden />}
              {busy ? "Importing…" : "Upload"}
            </Button>
          </div>
        </CardContent>
      </Card>

      {started && (
        <Card>
          <CardHeader>
            <CardTitle>{done ? "Dataset ready." : failure ? "Dataset import failed." : "Analyzing dataset…"}</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4" aria-live="polite">
            <ol className="space-y-1.5 text-sm">
              {STEPS.map((s) => {
                const st = steps[s.id];
                return (
                  <li key={s.id} className="flex items-start gap-2">
                    {st.status === "done" ? (
                      <CheckCircle2 className="mt-0.5 h-4 w-4 text-success" aria-label="done" />
                    ) : st.status === "running" ? (
                      <Loader2 className="mt-0.5 h-4 w-4 animate-spin text-primary" aria-label="in progress" />
                    ) : st.status === "skipped" ? (
                      <CheckCircle2 className="mt-0.5 h-4 w-4 text-muted-foreground" aria-label="skipped" />
                    ) : (
                      <span className="mt-1 h-3.5 w-3.5 rounded-full border border-border" aria-label="pending" />
                    )}
                    <span className={st.status === "pending" ? "text-muted-foreground" : ""}>
                      {s.label}
                      {st.detail ? <span className="text-muted-foreground"> — {st.detail}</span> : null}
                      {st.status === "skipped" ? <span className="text-muted-foreground"> (skipped)</span> : null}
                    </span>
                  </li>
                );
              })}
            </ol>

            {failure && (
              <div role="alert" className="rounded-lg border border-danger/30 bg-danger-bg p-3 text-sm text-danger">
                <p className="flex items-center gap-2 font-semibold">
                  <CircleAlert className="h-4 w-4" aria-hidden /> Dataset import failed.
                </p>
                <p className="mt-1">Reason: {failure.message}</p>
                {failure.details.length > 0 && (
                  <ul className="mt-2 list-inside list-disc text-xs">
                    {failure.details.map((d) => (
                      <li key={d}>{d}</li>
                    ))}
                  </ul>
                )}
                <p className="mt-2 text-xs">Nothing was imported — no partial data was kept.</p>
              </div>
            )}

            {done && (
              <div className="flex flex-wrap items-center gap-3">
                <p className="text-sm text-muted-foreground">
                  {done.tableCount} tables · {done.columnCount} columns · {done.rowCount.toLocaleString("en-US")} rows
                  {done.pendingRelationships > 0 ? ` · ${done.pendingRelationships} relationship${done.pendingRelationships === 1 ? "" : "s"} to review` : ""}
                </p>
                <Button onClick={() => router.push(`/datasets/${done.id}`)}>Review schema</Button>
              </div>
            )}
          </CardContent>
        </Card>
      )}
    </div>
  );
}
