"use client";

import { Database } from "lucide-react";
import { useEffect, useState } from "react";

interface MetadataTable {
  name: string;
  domain: string;
  description: string;
  columns: { name: string }[];
}

/** Collapsible list of the tables the demo database contains, from GET /api/metadata. */
export function SchemaExplorer({ datasetId = "demo" }: { datasetId?: string }) {
  const [tables, setTables] = useState<MetadataTable[]>([]);

  useEffect(() => {
    let cancelled = false;
    fetch(`/api/metadata?datasetId=${encodeURIComponent(datasetId)}`)
      .then((r) => r.json())
      .then((d) => !cancelled && setTables(d.tables ?? []))
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [datasetId]);

  const domains = [...new Set(tables.map((t) => t.domain))];

  return (
    <details className="rounded-xl border border-border bg-card p-3 shadow-sm">
      <summary className="flex cursor-pointer items-center gap-2 px-1 text-sm font-semibold">
        <Database className="h-4 w-4" aria-hidden /> What’s in the database? <span className="text-xs font-normal text-muted-foreground">({tables.length || 20} tables)</span>
      </summary>
      <div className="mt-3 space-y-3 px-1">
        {domains.map((d) => (
          <div key={d}>
            <h3 className="mb-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground">{d}</h3>
            <ul className="space-y-1">
              {tables
                .filter((t) => t.domain === d)
                .map((t) => (
                  <li key={t.name} title={t.description} className="text-xs">
                    <span className="font-mono text-foreground">{t.name}</span> <span className="text-muted-foreground">· {t.columns.length} cols</span>
                  </li>
                ))}
            </ul>
          </div>
        ))}
      </div>
    </details>
  );
}
