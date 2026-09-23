import type { DashboardAnalysis, TableAggregateResult } from "./analyze";
import type { ColumnQuality, DashboardQuality } from "./types";

/**
 * Honest, bounded data-quality reporting (see acceptance criteria in the master prompt, section 25): every number
 * here comes from the NULL counts already computed in analyze.ts's combined aggregate queries. Coverage is scoped to
 * the tables actually analyzed (the primary table + a few supporting ones — see analyze.ts's table ranking), and the
 * UI is told exactly that rather than implying a full-dataset scan that didn't happen.
 */

function columnsWithMissing(agg: TableAggregateResult): { list: ColumnQuality[]; nulls: number; cellsChecked: number } {
  const list: ColumnQuality[] = [];
  let nulls = 0;
  let checkedColumns = 0;
  const consider = (column: string, nullCount: number) => {
    checkedColumns++;
    nulls += nullCount;
    if (agg.rowCount > 0 && nullCount > 0) {
      list.push({ table: agg.table.name, column, nullCount, nullPercent: Math.round((nullCount / agg.rowCount) * 1000) / 10 });
    }
  };
  for (const [col, v] of Object.entries(agg.measures)) consider(col, v.nulls);
  for (const [col, v] of Object.entries(agg.dates)) consider(col, v.nulls);
  for (const [col, v] of Object.entries(agg.yearLike)) consider(col, v.nulls);
  for (const [col, v] of Object.entries(agg.categoricals)) consider(col, v.nulls);
  return { list, nulls, cellsChecked: checkedColumns * agg.rowCount };
}

export function buildQuality(analysis: DashboardAnalysis): DashboardQuality {
  const totalRows = analysis.allTables.reduce((a, t) => a + (t.rowCount ?? 0), 0);
  const totalColumns = analysis.allTables.reduce((a, t) => a + t.columns.length, 0);
  const totalTables = analysis.allTables.length;

  const analyzed = [analysis.primary, ...analysis.supporting].filter((a): a is TableAggregateResult => !!a);
  let totalNulls = 0;
  let totalCellsChecked = 0;
  const columnsWithMissingAll: ColumnQuality[] = [];
  for (const agg of analyzed) {
    const r = columnsWithMissing(agg);
    totalNulls += r.nulls;
    totalCellsChecked += r.cellsChecked;
    columnsWithMissingAll.push(...r.list);
  }

  const overallMissingPercent = totalCellsChecked > 0 ? Math.round((totalNulls / totalCellsChecked) * 1000) / 10 : 0;
  const coverageNote =
    analyzed.length === 0
      ? "No columns were suitable for automatic quality analysis."
      : totalTables <= analyzed.length
        ? "Quality analysis covers all tables in this dataset."
        : `Quality analysis covers the ${analyzed.length} most relevant of ${totalTables} tables in this dataset (the ones with the richest analyzable columns).`;

  return {
    totalRows,
    totalColumns,
    totalTables,
    overallMissingPercent,
    columnsWithMissing: columnsWithMissingAll.sort((a, b) => b.nullPercent - a.nullPercent),
    tablesAnalyzed: analyzed.length,
    coverageNote,
  };
}
