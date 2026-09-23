"use client";

import { Download } from "lucide-react";
import { Button } from "@/components/ui/button";
import { formatCell, humanizeColumn } from "@/lib/utils";

function toCsv(columns: string[], rows: Record<string, unknown>[]): string {
  const esc = (v: unknown) => {
    const s = v === null || v === undefined ? "" : String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return [columns.join(","), ...rows.map((r) => columns.map((c) => esc(r[c])).join(","))].join("\n");
}

export function ResultTable({ columns, rows, truncated }: { columns: string[]; rows: Record<string, unknown>[]; truncated: boolean }) {
  function download() {
    const blob = new Blob([toCsv(columns, rows)], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "results.csv";
    a.click();
    URL.revokeObjectURL(url);
  }

  if (!Array.isArray(columns) || columns.length === 0 || !Array.isArray(rows) || rows.length === 0) {
    return (
      <div className="rounded-lg border border-dashed border-border py-10 text-center text-sm text-muted-foreground">No matching records were found.</div>
    );
  }

  return (
    <div>
      <div className="max-h-[420px] overflow-auto rounded-lg border border-border">
        <table className="w-full min-w-max border-collapse text-sm">
          <caption className="sr-only">Query results</caption>
          <thead className="sticky top-0 z-10 bg-muted text-left text-xs uppercase tracking-wide text-muted-foreground">
            <tr>
              {columns.map((c) => (
                <th key={c} scope="col" className="whitespace-nowrap px-3 py-2 font-medium">
                  {humanizeColumn(c)}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((row, i) => (
              <tr key={i} className="border-t border-border odd:bg-transparent even:bg-muted/40 hover:bg-accent/60">
                {columns.map((c) => {
                  const v = row?.[c];
                  return (
                    <td key={c} className={`max-w-[320px] truncate px-3 py-2 ${typeof v === "number" ? "text-right tabular-nums" : ""}`} title={typeof v === "string" && v.length > 40 ? v : undefined}>
                      {formatCell(v)}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="mt-2 flex items-center justify-between text-xs text-muted-foreground">
        <span>
          {rows.length} row{rows.length === 1 ? "" : "s"}
          {truncated ? " — result truncated at the row limit" : ""}
        </span>
        <Button variant="ghost" size="sm" onClick={download} aria-label="Download results as CSV">
          <Download className="h-3.5 w-3.5" aria-hidden /> CSV
        </Button>
      </div>
    </div>
  );
}
