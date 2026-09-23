"use client";

import { Clock, Wrench } from "lucide-react";
import { Badge } from "@/components/ui/badge";

export function SupportingInfo({
  datasetName,
  tablesUsed,
  rowCount,
  truncated,
  columnCount,
  executionTimeMs,
  totalLatencyMs,
  attempts,
}: {
  datasetName?: string;
  tablesUsed: string[];
  rowCount: number;
  truncated: boolean;
  columnCount: number;
  executionTimeMs?: number;
  totalLatencyMs: number;
  attempts: number;
}) {
  return (
    <div className="flex flex-wrap items-center gap-2 text-xs">
      {datasetName && <Badge tone="neutral">Dataset: {datasetName}</Badge>}
      {tablesUsed.length > 0 && (
        <span className="flex flex-wrap items-center gap-1.5">
          <span className="text-muted-foreground">Tables:</span>
          {tablesUsed.map((t) => (
            <Badge key={t} tone="accent" className="font-mono">
              {t}
            </Badge>
          ))}
        </span>
      )}
      <Badge>
        {rowCount.toLocaleString("en-US")}
        {truncated ? "+" : ""} row{rowCount === 1 && !truncated ? "" : "s"} · {columnCount} col{columnCount === 1 ? "" : "s"}
      </Badge>
      {executionTimeMs !== undefined && (
        <Badge>
          <Clock className="h-3 w-3" aria-hidden /> {executionTimeMs} ms query · {totalLatencyMs} ms total
        </Badge>
      )}
      {attempts > 1 && (
        <Badge tone="warning">
          <Wrench className="h-3 w-3" aria-hidden /> self-corrected in {attempts} attempts
        </Badge>
      )}
    </div>
  );
}
