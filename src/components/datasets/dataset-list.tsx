"use client";

import { AlertTriangle, ArrowLeft, Database, Loader2, Plus } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { PrivacyNotice } from "./privacy-notice";
import { ACTIVE_DATASET_KEY, SOURCE_LABEL, summarise, type DatasetDto, type UploadLimitsDto } from "./types";

export function DatasetList() {
  const router = useRouter();
  const [datasets, setDatasets] = useState<DatasetDto[] | null>(null);
  const [activeId, setActiveId] = useState("demo");
  const [limits, setLimits] = useState<UploadLimitsDto | undefined>();

  useEffect(() => {
    let cancelled = false;
    fetch("/api/datasets")
      .then((r) => r.json())
      .then((d) => {
        if (cancelled) return;
        setDatasets(d.datasets ?? []);
        setLimits(d.limits);
        try {
          setActiveId(localStorage.getItem(ACTIVE_DATASET_KEY) ?? d.activeId ?? "demo");
        } catch {
          setActiveId(d.activeId ?? "demo");
        }
      })
      .catch(() => !cancelled && setDatasets([]));
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <div className="mx-auto w-full max-w-4xl flex-1 space-y-6 px-4 py-6 sm:px-6 lg:py-10">
      <Link href="/" className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground">
        <ArrowLeft className="h-4 w-4" aria-hidden /> Back to questions
      </Link>
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">My datasets</h1>
          <p className="mt-1 text-sm text-muted-foreground">Ask questions about the built-in demo or about your own SQL/CSV data, each in its own isolated schema.</p>
        </div>
        <Button onClick={() => router.push("/datasets/new")}>
          <Plus className="h-4 w-4" aria-hidden /> Add Dataset
        </Button>
      </header>

      <PrivacyNotice limits={limits} />

      {datasets === null ? (
        <div className="space-y-3">
          <Skeleton className="h-24" />
          <Skeleton className="h-24" />
        </div>
      ) : (
        <ul className="space-y-3">
          {datasets.map((d) => (
            <li key={d.id}>
              <Card className={d.id === activeId && d.status === "ready" ? "border-primary" : ""}>
                <CardContent className="flex flex-wrap items-center justify-between gap-3">
                  <div className="min-w-0 space-y-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <Database className="h-4 w-4 text-primary" aria-hidden />
                      <h2 className="font-semibold">{d.name}</h2>
                      <Badge tone={d.isBuiltin ? "accent" : "neutral"}>{SOURCE_LABEL[d.sourceType]}</Badge>
                      {d.status === "processing" && (
                        <Badge tone="warning">
                          <Loader2 className="h-3 w-3 animate-spin" aria-hidden /> processing
                        </Badge>
                      )}
                      {d.status === "failed" && (
                        <Badge tone="danger">
                          <AlertTriangle className="h-3 w-3" aria-hidden /> failed
                        </Badge>
                      )}
                      {d.id === activeId && d.status === "ready" && <Badge tone="success">in use</Badge>}
                      {d.pendingRelationships > 0 && <Badge tone="warning">{d.pendingRelationships} relationship(s) to review</Badge>}
                    </div>
                    {d.status === "failed" ? (
                      <p className="text-sm text-danger">Dataset import failed. Reason: {d.error ?? "unknown"}</p>
                    ) : (
                      <p className="text-sm text-muted-foreground">
                        {summarise(d)} · {d.columnCount} columns · {d.relationshipCount} relationships · added {new Date(d.createdAt).toLocaleDateString()}
                      </p>
                    )}
                  </div>
                  <Button variant="outline" onClick={() => router.push(`/datasets/${d.id}`)}>
                    Open
                  </Button>
                </CardContent>
              </Card>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
