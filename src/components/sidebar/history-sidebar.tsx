"use client";

import { CheckCircle2, CircleAlert, HelpCircle, History, MinusCircle } from "lucide-react";
import { Skeleton } from "@/components/ui/skeleton";
import { relativeTime } from "@/lib/utils";

export interface HistoryItem {
  id: string;
  datasetId?: string;
  datasetName?: string;
  question: string;
  status: string;
  attempts: number;
  createdAt: string;
}

const STATUS_ICON: Record<string, { icon: typeof CheckCircle2; className: string; label: string }> = {
  success: { icon: CheckCircle2, className: "text-success", label: "answered" },
  no_results: { icon: MinusCircle, className: "text-muted-foreground", label: "no results" },
  out_of_scope: { icon: MinusCircle, className: "text-muted-foreground", label: "out of scope" },
  needs_clarification: { icon: HelpCircle, className: "text-warning", label: "needs clarification" },
  error: { icon: CircleAlert, className: "text-danger", label: "error" },
};

export function HistorySidebar({ items, loading, onSelect, disabled, datasetName, showAll, onToggleAll }: { items: HistoryItem[]; loading: boolean; onSelect: (item: HistoryItem) => void; disabled: boolean; datasetName?: string; showAll?: boolean; onToggleAll?: () => void }) {
  return (
    <nav aria-label="Recent questions" className="rounded-xl border border-border bg-card p-3 shadow-sm">
      <h2 className="mb-2 flex items-center gap-2 px-1 text-sm font-semibold">
        <History className="h-4 w-4" aria-hidden /> Recent questions
      </h2>
      {datasetName && (
        <p className="mb-2 px-1 text-xs text-muted-foreground">
          {showAll ? "All datasets" : `In ${datasetName}`}
          {onToggleAll && (
            <button type="button" onClick={onToggleAll} className="ml-2 text-primary underline-offset-2 hover:underline">
              {showAll ? "only this dataset" : "show all"}
            </button>
          )}
        </p>
      )}
      {loading ? (
        <div className="space-y-2 p-1">
          <Skeleton className="h-8" />
          <Skeleton className="h-8" />
          <Skeleton className="h-8" />
        </div>
      ) : items.length === 0 ? (
        <p className="px-1 py-2 text-xs text-muted-foreground">Questions you ask will appear here.</p>
      ) : (
        <ul className="space-y-0.5">
          {items.map((it) => {
            const s = STATUS_ICON[it.status] ?? STATUS_ICON.error;
            const Icon = s.icon;
            return (
              <li key={it.id}>
                <button
                  type="button"
                  disabled={disabled}
                  onClick={() => onSelect(it)}
                  className="flex w-full items-start gap-2 rounded-lg px-2 py-1.5 text-left text-sm transition-colors hover:bg-muted disabled:opacity-50"
                >
                  <Icon className={`mt-0.5 h-4 w-4 shrink-0 ${s.className}`} aria-label={s.label} />
                  <span className="min-w-0">
                    <span className="line-clamp-2">{it.question}</span>
                    <span className="text-xs text-muted-foreground">
                      {showAll && it.datasetName ? `${it.datasetName} · ` : ""}
                      {relativeTime(it.createdAt)}
                      {it.attempts > 1 ? ` · ${it.attempts} attempts` : ""}
                    </span>
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </nav>
  );
}
