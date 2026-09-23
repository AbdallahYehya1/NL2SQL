import { CircleCheck, CircleOff, Sparkles } from "lucide-react";
import { formatNumberFull } from "@/lib/format";
import type { DashboardData } from "@/lib/dashboard/types";

export function DatasetHeader({ data }: { data: DashboardData }) {
  return (
    <div className="rounded-2xl border border-border bg-card p-5 sm:p-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="flex items-center gap-2 text-primary">
            <Sparkles className="h-4 w-4" aria-hidden />
            <span className="text-xs font-semibold uppercase tracking-widest">Data Dashboard</span>
          </div>
          <h1 className="mt-1 text-xl font-semibold tracking-tight sm:text-2xl">{data.datasetName}</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            {formatNumberFull(data.tableCount)} table{data.tableCount === 1 ? "" : "s"} · {formatNumberFull(data.rowCount)} rows · {formatNumberFull(data.columnCount)} columns
          </p>
          {data.description && <p className="mt-2 max-w-2xl text-sm text-muted-foreground">{data.description}</p>}
        </div>
        <span className={`flex shrink-0 items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-medium ${data.aiAvailable ? "bg-success-bg text-success" : "bg-muted text-muted-foreground"}`}>
          {data.aiAvailable ? <CircleCheck className="h-3.5 w-3.5" aria-hidden /> : <CircleOff className="h-3.5 w-3.5" aria-hidden />}
          {data.aiAvailable ? "AI Available" : "AI Unavailable"}
        </span>
      </div>
    </div>
  );
}
