"use client";

import { Database } from "lucide-react";
import Link from "next/link";
import { useId } from "react";
import { summarise, type DatasetDto } from "./types";

/** Dropdown that chooses the dataset every question runs against. Only ready datasets can be selected. */
export function DatasetSelector({ datasets, activeId, onChange, disabled }: { datasets: DatasetDto[]; activeId: string; onChange: (id: string) => void; disabled?: boolean }) {
  const id = useId();
  const usable = datasets.filter((d) => d.status === "ready");
  return (
    <div className="flex flex-wrap items-end gap-3">
      <div>
        <label htmlFor={id} className="mb-1 block text-xs font-medium text-muted-foreground">
          Dataset
        </label>
        <div className="relative">
          <Database className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" aria-hidden />
          <select
            id={id}
            value={activeId}
            disabled={disabled}
            onChange={(e) => onChange(e.target.value)}
            className="h-10 min-w-56 rounded-lg border border-border bg-card pl-8 pr-8 text-sm font-medium disabled:opacity-60"
          >
            {usable.map((d) => (
              <option key={d.id} value={d.id}>
                {d.name} — {summarise(d)}
              </option>
            ))}
          </select>
        </div>
      </div>
      <Link href="/datasets" className="pb-2.5 text-sm text-primary underline-offset-2 hover:underline">
        Manage datasets
      </Link>
    </div>
  );
}
