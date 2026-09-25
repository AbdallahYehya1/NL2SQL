import { quoteIdent } from "@/lib/datasets/sql-util";
import type { ColumnMeta, TableMeta } from "@/lib/types";

/**
 * Builds small, fully app-controlled aggregation SQL (never LLM-generated) for the dashboard's deterministic
 * engines. Every identifier is quoted and comes from the dataset's own registry (never user input), and the SQL
 * still passes through the same validateSql()/executeQuery() pipeline as any other query — see query-runner.ts —
 * so it never bypasses the read-only sandbox, dataset isolation, or row/time limits.
 */

const q = quoteIdent;
export const MAX_MEASURES_PER_TABLE = 3;
export const MAX_CATEGORICALS_PER_TABLE = 3;

export interface TableAggregateKeys {
  rowCountAlias: string;
  measures: Record<string, { sum: string; avg: string; min: string; max: string; nulls: string }>;
  dates: Record<string, { min: string; max: string; nulls: string }>;
  yearLike: Record<string, { min: string; max: string; nulls: string }>;
  categoricals: Record<string, { distinct: string; nulls: string }>;
}

/**
 * One combined SELECT for a table: row count, SUM/AVG/MIN/MAX per measure, MIN/MAX per date (and per year-like
 * integer column), COUNT(DISTINCT) per categorical, and a NULL count for every column passed in — all in a single
 * scan of the table.
 */
export function buildTableAggregateSql(table: TableMeta, opts: { measures: ColumnMeta[]; dates: ColumnMeta[]; yearLike?: ColumnMeta[]; categoricals: ColumnMeta[] }): { sql: string; keys: TableAggregateKeys } {
  const rowCountAlias = "row_count";
  const exprs: string[] = [`COUNT(*) AS ${q(rowCountAlias)}`];
  const keys: TableAggregateKeys = { rowCountAlias, measures: {}, dates: {}, yearLike: {}, categoricals: {} };

  for (const c of opts.measures.slice(0, MAX_MEASURES_PER_TABLE)) {
    const col = q(c.name);
    const sum = `m_${c.name}_sum`, avg = `m_${c.name}_avg`, min = `m_${c.name}_min`, max = `m_${c.name}_max`, nulls = `m_${c.name}_nulls`;
    exprs.push(`SUM(${col}) AS ${q(sum)}`, `AVG(${col}) AS ${q(avg)}`, `MIN(${col}) AS ${q(min)}`, `MAX(${col}) AS ${q(max)}`, `SUM(CASE WHEN ${col} IS NULL THEN 1 ELSE 0 END) AS ${q(nulls)}`);
    keys.measures[c.name] = { sum, avg, min, max, nulls };
  }
  for (const c of opts.dates) {
    const col = q(c.name);
    const min = `d_${c.name}_min`, max = `d_${c.name}_max`, nulls = `d_${c.name}_nulls`;
    exprs.push(`MIN(${col}) AS ${q(min)}`, `MAX(${col}) AS ${q(max)}`, `SUM(CASE WHEN ${col} IS NULL THEN 1 ELSE 0 END) AS ${q(nulls)}`);
    keys.dates[c.name] = { min, max, nulls };
  }
  for (const c of opts.yearLike ?? []) {
    const col = q(c.name);
    const min = `y_${c.name}_min`, max = `y_${c.name}_max`, nulls = `y_${c.name}_nulls`;
    exprs.push(`MIN(${col}) AS ${q(min)}`, `MAX(${col}) AS ${q(max)}`, `SUM(CASE WHEN ${col} IS NULL THEN 1 ELSE 0 END) AS ${q(nulls)}`);
    keys.yearLike[c.name] = { min, max, nulls };
  }
  for (const c of opts.categoricals.slice(0, MAX_CATEGORICALS_PER_TABLE)) {
    const col = q(c.name);
    const distinct = `c_${c.name}_distinct`, nulls = `c_${c.name}_nulls`;
    exprs.push(`COUNT(DISTINCT ${col}) AS ${q(distinct)}`, `SUM(CASE WHEN ${col} IS NULL THEN 1 ELSE 0 END) AS ${q(nulls)}`);
    keys.categoricals[c.name] = { distinct, nulls };
  }

  return { sql: `SELECT ${exprs.join(", ")} FROM ${q(table.name)}`, keys };
}

/** GROUP BY a categorical column, ranked by the measure's SUM (or, with no measure, by row count). */
export function buildCategoryBreakdownSql(table: TableMeta, categoryCol: ColumnMeta, measureCol: ColumnMeta | undefined, limit: number): string {
  const cat = q(categoryCol.name);
  const value = measureCol ? `SUM(${q(measureCol.name)})` : "COUNT(*)";
  return `SELECT ${cat} AS ${q("category")}, ${value} AS ${q("value")}, COUNT(*) AS ${q("n")} FROM ${q(table.name)} WHERE ${cat} IS NOT NULL GROUP BY ${cat} ORDER BY ${q("value")} DESC LIMIT ${limit}`;
}

/** GROUP BY month(dateCol), ranked chronologically — the source for both the time-series chart and trend/peak insights. */
export function buildTimeSeriesSql(table: TableMeta, dateCol: ColumnMeta, measureCol: ColumnMeta | undefined, limit: number): string {
  const d = q(dateCol.name);
  const value = measureCol ? `SUM(${q(measureCol.name)})` : "COUNT(*)";
  return `SELECT DATE_TRUNC('month', ${d})::date AS ${q("period")}, ${value} AS ${q("value")}, COUNT(*) AS ${q("n")} FROM ${q(table.name)} WHERE ${d} IS NOT NULL GROUP BY 1 ORDER BY 1 LIMIT ${limit}`;
}

/**
 * A bounded sample of two numeric columns for a scatter plot. Uses a plain LIMIT (no ORDER BY random()) — real,
 * unfabricated values, just not a uniformly-random sample — because sorting the whole table randomly would be a
 * full table scan on every dashboard load, which the performance requirement explicitly rules out.
 */
export function buildScatterSampleSql(table: TableMeta, colA: ColumnMeta, colB: ColumnMeta, limit: number): string {
  const a = q(colA.name), b = q(colB.name);
  return `SELECT ${a} AS ${q("x")}, ${b} AS ${q("y")} FROM ${q(table.name)} WHERE ${a} IS NOT NULL AND ${b} IS NOT NULL LIMIT ${limit}`;
}

/**
 * Real row count for EVERY table in one round trip (one UNION ALL query) — used because the registry's own
 * `TableMeta.rowCount` is reliably populated for uploaded datasets (captured at import time) but NOT for the
 * built-in demo (a static, curated registry that was never introspected), which would otherwise make table
 * ranking and the dashboard's row-count totals silently wrong for the demo. Table names are quoted identifiers
 * from the query, but the literal in the SELECT list must be a genuine string, hence the escaped '…' literal.
 */
export function buildAllTableRowCountsSql(tableNames: string[]): string {
  return tableNames.map((t) => `SELECT '${t.replace(/'/g, "''")}' AS ${q("table_name")}, COUNT(*) AS ${q("n")} FROM ${q(t)}`).join(" UNION ALL ");
}

/** GROUP BY an already-discrete "year"/"quarter"-shaped integer column — same shape as the time-series query, no truncation needed. */
export function buildYearBreakdownSql(table: TableMeta, yearCol: ColumnMeta, measureCol: ColumnMeta | undefined, limit: number): string {
  const y = q(yearCol.name);
  const value = measureCol ? `SUM(${q(measureCol.name)})` : "COUNT(*)";
  return `SELECT ${y} AS ${q("period")}, ${value} AS ${q("value")}, COUNT(*) AS ${q("n")} FROM ${q(table.name)} WHERE ${y} IS NOT NULL GROUP BY ${y} ORDER BY ${y} LIMIT ${limit}`;
}
