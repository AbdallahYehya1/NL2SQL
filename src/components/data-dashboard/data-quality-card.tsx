import { ShieldCheck } from "lucide-react";
import { formatNumberFull } from "@/lib/format";
import type { DashboardQuality } from "@/lib/dashboard/types";

/** Honest data-quality reporting: no "quality score", no claim of completeness beyond what was actually checked. */
export function DataQualityCard({ quality }: { quality: DashboardQuality }) {
  return (
    <div className="space-y-3 rounded-2xl border border-border bg-card p-4 sm:p-5">
      <h2 className="text-sm font-semibold text-foreground">Data Quality</h2>
      <dl className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Metric label="Rows" value={formatNumberFull(quality.totalRows)} />
        <Metric label="Columns" value={formatNumberFull(quality.totalColumns)} />
        <Metric label="Tables" value={formatNumberFull(quality.totalTables)} />
        <Metric label="Missing values" value={`${quality.overallMissingPercent}%`} />
      </dl>

      {quality.columnsWithMissing.length === 0 ? (
        <p className="flex items-center gap-1.5 text-sm text-success">
          <ShieldCheck className="h-4 w-4" aria-hidden />
          No missing values were detected in the analyzed columns.
        </p>
      ) : (
        <ul className="space-y-1 text-sm text-muted-foreground">
          {quality.columnsWithMissing.slice(0, 5).map((c) => (
            <li key={`${c.table}.${c.column}`}>
              <span className="font-mono text-foreground">
                {c.table}.{c.column}
              </span>{" "}
              is missing in {c.nullPercent}% of rows ({formatNumberFull(c.nullCount)}).
            </li>
          ))}
        </ul>
      )}
      <p className="text-xs text-muted-foreground">{quality.coverageNote}</p>
    </div>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="text-lg font-semibold tabular-nums text-foreground">{value}</dd>
    </div>
  );
}
