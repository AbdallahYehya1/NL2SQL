"use client";

import { ArrowLeft, BarChart3, Database, MessageSquare } from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import { fmt, type DatasetDto } from "@/components/datasets/types";

interface Tab {
  href: string;
  label: string;
  icon: React.ComponentType<{ className?: string }>;
  /** Exact match only for the workspace's own index route, so "/datasets/x" doesn't also light up for "/datasets/x/dashboard". */
  exact?: boolean;
}

/**
 * Persistent context bar + tab navigation for one dataset's workspace (Data / Dashboard / Ask this data). Rendered
 * once by the shared layout (src/app/datasets/[id]/layout.tsx) so it survives navigation between those three real
 * routes — the user is never in doubt about which dataset they're in, and browser back/forward, direct URLs and
 * refresh all behave correctly because every tab is an ordinary link to an ordinary route, not client-only state.
 */
export function DatasetWorkspaceHeader({ id }: { id: string }) {
  const pathname = usePathname();
  const [dataset, setDataset] = useState<DatasetDto | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch(`/api/datasets/${id}`)
      .then((r) => r.json())
      .then((body) => {
        if (!cancelled) setDataset(body.dataset ?? null);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [id]);

  const tabs: Tab[] = [
    { href: `/datasets/${id}`, label: "Data", icon: Database, exact: true },
    { href: `/datasets/${id}/dashboard`, label: "Dashboard", icon: BarChart3 },
    { href: `/datasets/${id}/ask`, label: "Ask this data", icon: MessageSquare },
  ];

  return (
    <div className="border-b border-border bg-card">
      <div className="mx-auto max-w-6xl space-y-3 px-4 py-4 sm:px-6">
        <Link href="/datasets" className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground">
          <ArrowLeft className="h-3.5 w-3.5" aria-hidden /> Datasets
        </Link>
        <div>
          <h1 className="text-lg font-semibold tracking-tight text-foreground">{dataset?.name ?? " "}</h1>
          {dataset && (
            <p className="text-sm text-muted-foreground">
              {fmt.format(dataset.tableCount)} table{dataset.tableCount === 1 ? "" : "s"} · {fmt.format(dataset.rowCount)} rows
            </p>
          )}
        </div>
        <nav aria-label="Dataset" className="-mb-4 flex gap-1 overflow-x-auto">
          {tabs.map((t) => {
            const active = t.exact ? pathname === t.href : pathname?.startsWith(t.href);
            const Icon = t.icon;
            return (
              <Link
                key={t.href}
                href={t.href}
                aria-current={active ? "page" : undefined}
                className={`flex shrink-0 items-center gap-1.5 border-b-2 px-3 py-2 text-sm font-medium transition-colors ${active ? "border-primary text-foreground" : "border-transparent text-muted-foreground hover:text-foreground"}`}
              >
                <Icon className="h-3.5 w-3.5" aria-hidden /> {t.label}
              </Link>
            );
          })}
        </nav>
      </div>
    </div>
  );
}
