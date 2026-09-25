"use client";

import { BarChart3, Check, KeyRound, Link2, Loader2, MessageSquare, Sparkles, Trash2 } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button, buttonVariants } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { PrivacyNotice } from "./privacy-notice";
import { ACTIVE_DATASET_KEY, fmt, SOURCE_LABEL, type DatasetDetailsDto, type SuggestedRelationship } from "./types";

const relKey = (r: { fromTable: string; fromColumn: string; toTable: string; toColumn: string }) => `${r.fromTable}.${r.fromColumn}->${r.toTable}.${r.toColumn}`;

export function DatasetDetails({ id }: { id: string }) {
  const router = useRouter();
  const [data, setData] = useState<DatasetDetailsDto | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [chosen, setChosen] = useState<Set<string>>(new Set());
  const [confirmDelete, setConfirmDelete] = useState(false);

  useEffect(() => {
    let cancelled = false;
    fetch(`/api/datasets/${id}`)
      .then(async (res) => {
        const body = await res.json();
        if (cancelled) return;
        if (!res.ok) return setError(body.error ?? "Dataset not found.");
        setData(body);
        setChosen(new Set((body.suggestedRelationships as SuggestedRelationship[]).map(relKey)));
      })
      .catch(() => !cancelled && setError("Dataset unavailable."));
    return () => {
      cancelled = true;
    };
  }, [id]);

  async function useDataset() {
    setBusy("use");
    const res = await fetch(`/api/datasets/${id}/activate`, { method: "POST" });
    if (!res.ok) {
      setError((await res.json().catch(() => ({}))).error ?? "Could not activate the dataset.");
      setBusy(null);
      return;
    }
    try {
      localStorage.setItem(ACTIVE_DATASET_KEY, id);
    } catch {
      /* storage unavailable: the cookie still records the choice */
    }
    router.push("/");
  }

  async function review(confirm: boolean) {
    if (!data) return;
    setBusy("rel");
    const picked = confirm ? data.suggestedRelationships.filter((r) => chosen.has(relKey(r))) : [];
    const res = await fetch(`/api/datasets/${id}/relationships`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ confirm: picked.map(({ fromTable, fromColumn, toTable, toColumn }) => ({ fromTable, fromColumn, toTable, toColumn })), dismissRest: true }),
    });
    const body = await res.json();
    if (!res.ok) setError(body.error ?? "Could not save the relationships.");
    else {
      setData(body);
      setError(null);
    }
    setBusy(null);
  }

  async function remove() {
    setBusy("delete");
    const res = await fetch(`/api/datasets/${id}`, { method: "DELETE" });
    if (res.ok) {
      try {
        if (localStorage.getItem(ACTIVE_DATASET_KEY) === id) localStorage.removeItem(ACTIVE_DATASET_KEY);
      } catch {
        /* ignore */
      }
      router.push("/datasets");
    } else {
      setError((await res.json().catch(() => ({}))).error ?? "Could not delete the dataset.");
      setBusy(null);
    }
  }

  const d = data?.dataset;

  return (
    <div className="mx-auto w-full max-w-4xl flex-1 space-y-6 px-4 py-6 sm:px-6 lg:py-10">
      {error && !data ? (
        <div role="alert" className="rounded-xl border border-danger/30 bg-danger-bg p-4 text-sm text-danger">
          {error}
        </div>
      ) : !data || !d ? (
        <div className="space-y-3">
          <Skeleton className="h-10 w-1/2" />
          <Skeleton className="h-32" />
        </div>
      ) : (
        <>
          <header className="space-y-2">
            <div className="flex flex-wrap items-center gap-2">
              <h1 className="text-2xl font-semibold tracking-tight">{d.name}</h1>
              <Badge tone={d.isBuiltin ? "accent" : "neutral"}>{SOURCE_LABEL[d.sourceType]}</Badge>
              <Badge tone={d.status === "ready" ? "success" : d.status === "failed" ? "danger" : "warning"}>{d.status}</Badge>
            </div>
            <p className="text-sm text-muted-foreground">
              Added {new Date(d.createdAt).toLocaleString()}
              {d.embeddingStatus ? ` · embeddings: ${d.embeddingStatus}` : ""}
              {d.descriptionsGeneratedBy ? " · some descriptions are AI-generated" : ""}
            </p>
          </header>

          {d.status === "failed" ? (
            <div role="alert" className="rounded-xl border border-danger/30 bg-danger-bg p-4 text-sm text-danger">
              <p className="font-semibold">Dataset import failed.</p>
              <p className="mt-1">Reason: {d.error}</p>
            </div>
          ) : (
            <>
              {d.status === "ready" && (
                <div className="rounded-2xl border border-border bg-card p-5 sm:p-6">
                  <p className="text-sm text-muted-foreground">Explore your data and discover insights.</p>
                  <div className="mt-3 flex flex-wrap gap-2">
                    <Link href={`/datasets/${id}/dashboard`} className={buttonVariants({ size: "md" })}>
                      <BarChart3 className="h-4 w-4" aria-hidden /> View Dashboard
                    </Link>
                    <Link href={`/datasets/${id}/ask`} className={buttonVariants({ variant: "outline", size: "md" })}>
                      <MessageSquare className="h-4 w-4" aria-hidden /> Ask a Question
                    </Link>
                  </div>
                </div>
              )}

              <dl className="grid grid-cols-2 gap-3 sm:grid-cols-4">
                <Metric label="Tables" value={fmt.format(d.tableCount)} />
                <Metric label="Columns" value={fmt.format(d.columnCount)} />
                <Metric label="Rows" value={fmt.format(d.rowCount)} />
                <Metric label="Relationships" value={fmt.format(d.relationshipCount)} />
              </dl>

              {!d.isBuiltin && <PrivacyNotice />}

              <div className="flex flex-wrap gap-2">
                {d.status === "ready" && (
                  <Button variant="outline" onClick={useDataset} disabled={busy !== null}>
                    {busy === "use" ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : <Check className="h-4 w-4" aria-hidden />} Use on Main Page
                  </Button>
                )}
                {!d.isBuiltin &&
                  (confirmDelete ? (
                    <>
                      <Button variant="outline" onClick={remove} disabled={busy !== null} className="border-danger text-danger">
                        {busy === "delete" ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : <Trash2 className="h-4 w-4" aria-hidden />} Yes, delete it
                      </Button>
                      <Button variant="ghost" onClick={() => setConfirmDelete(false)}>
                        Cancel
                      </Button>
                    </>
                  ) : (
                    <Button variant="outline" onClick={() => setConfirmDelete(true)}>
                      <Trash2 className="h-4 w-4" aria-hidden /> Delete
                    </Button>
                  ))}
              </div>
              {error && (
                <p role="alert" className="text-sm text-danger">
                  {error}
                </p>
              )}

              {data.suggestedRelationships.length > 0 && (
                <Card className="border-warning/40">
                  <CardHeader>
                    <CardTitle className="flex items-center gap-2">
                      <Link2 className="h-4 w-4" aria-hidden /> Review suggested relationships
                    </CardTitle>
                  </CardHeader>
                  <CardContent className="space-y-3">
                    <p className="text-sm text-muted-foreground">
                      CSV files contain no constraints, so these are only <strong>suggestions</strong> based on column names and a check of your data. They are not part of the schema until you confirm them; confirmed ones become real foreign keys.
                    </p>
                    <ul className="space-y-2">
                      {data.suggestedRelationships.map((r) => (
                        <li key={relKey(r)}>
                          <label className="flex items-start gap-2 text-sm">
                            <input
                              type="checkbox"
                              className="mt-1"
                              checked={chosen.has(relKey(r))}
                              onChange={(e) =>
                                setChosen((prev) => {
                                  const next = new Set(prev);
                                  if (e.target.checked) next.add(relKey(r));
                                  else next.delete(relKey(r));
                                  return next;
                                })
                              }
                            />
                            <span>
                              <span className="font-mono">
                                {r.fromTable}.{r.fromColumn} → {r.toTable}.{r.toColumn}
                              </span>
                              <span className="block text-xs text-muted-foreground">{r.evidence}</span>
                            </span>
                          </label>
                        </li>
                      ))}
                    </ul>
                    <div className="flex flex-wrap gap-2">
                      <Button onClick={() => review(true)} disabled={busy !== null || chosen.size === 0}>
                        {busy === "rel" && <Loader2 className="h-4 w-4 animate-spin" aria-hidden />} Confirm selected
                      </Button>
                      <Button variant="outline" onClick={() => review(false)} disabled={busy !== null}>
                        Not relationships — dismiss all
                      </Button>
                    </div>
                  </CardContent>
                </Card>
              )}

              <Card>
                <CardHeader>
                  <CardTitle>Relationships</CardTitle>
                </CardHeader>
                <CardContent>
                  {data.relationships.length === 0 ? (
                    <p className="text-sm text-muted-foreground">No relationships. Questions that need a join between tables cannot be answered until a foreign key exists.</p>
                  ) : (
                    <ul className="space-y-1 font-mono text-sm">
                      {data.relationships.map((r) => (
                        <li key={relKey(r)}>
                          {r.fromTable}.{r.fromColumn} → {r.toTable}.{r.toColumn}
                        </li>
                      ))}
                    </ul>
                  )}
                </CardContent>
              </Card>

              <Card>
                <CardHeader>
                  <CardTitle>Tables ({data.tables.length})</CardTitle>
                </CardHeader>
                <CardContent className="space-y-3">
                  {data.tables.map((t) => (
                    <details key={t.name} className="rounded-lg border border-border p-3">
                      <summary className="cursor-pointer text-sm">
                        <span className="font-mono font-semibold">{t.name}</span>
                        <span className="ml-2 text-muted-foreground">
                          {t.columns.length} columns{t.rowCount !== undefined ? ` · ${fmt.format(t.rowCount)} rows` : ""}
                        </span>
                      </summary>
                      <p className="mt-2 text-sm text-muted-foreground">
                        {t.description}
                        {t.descriptionSource === "llm" && <Badge tone="accent" className="ml-2"><Sparkles className="h-3 w-3" aria-hidden /> AI-generated</Badge>}
                      </p>
                      <table className="mt-2 w-full text-left text-xs">
                        <thead className="text-muted-foreground">
                          <tr>
                            <th className="py-1 pr-2 font-medium">Column</th>
                            <th className="py-1 pr-2 font-medium">Type</th>
                            <th className="py-1 pr-2 font-medium">Keys</th>
                            <th className="py-1 font-medium">Example values</th>
                          </tr>
                        </thead>
                        <tbody>
                          {t.columns.map((c) => (
                            <tr key={c.name} className="border-t border-border align-top">
                              <td className="py-1 pr-2 font-mono">{c.name}</td>
                              <td className="py-1 pr-2">
                                {c.type}
                                {c.nullable === false ? " · not null" : ""}
                              </td>
                              <td className="py-1 pr-2">
                                {c.primaryKey && (
                                  <span className="inline-flex items-center gap-1">
                                    <KeyRound className="h-3 w-3" aria-hidden /> PK
                                  </span>
                                )}
                                {c.references && <span className="block font-mono">→ {c.references}</span>}
                              </td>
                              <td className="py-1 text-muted-foreground">{c.sampleValues?.join(", ") ?? "—"}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </details>
                  ))}
                </CardContent>
              </Card>
            </>
          )}
        </>
      )}
    </div>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-xl border border-border bg-card p-3">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="text-xl font-semibold tabular-nums">{value}</dd>
    </div>
  );
}
