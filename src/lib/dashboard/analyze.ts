import type { AppConfig } from "@/lib/config";
import { executeQuery } from "@/lib/database/executor";
import type { DatasetContext } from "@/lib/datasets/context";
import type { ColumnMeta, TableMeta } from "@/lib/types";
import { isRealCategory, rankTables, type TableColumnProfile } from "./column-classify";
import { buildAllTableRowCountsSql, buildCategoryBreakdownSql, buildScatterSampleSql, buildTableAggregateSql, buildTimeSeriesSql, buildYearBreakdownSql } from "./sql-builder";
import { runDashboardQuery, type QueryExecutor } from "./query-runner";

/**
 * The single query pass every dashboard engine (KPI, insight, visualization, quality) reads from — computed once so
 * the dashboard runs a bounded, small number of queries (one combined aggregate query per analyzed table, plus at
 * most one category-breakdown and one time-series query for the primary table) rather than a query per metric.
 */

export interface TableAggregateResult {
  table: TableMeta;
  profile: TableColumnProfile;
  rowCount: number;
  measures: Record<string, { sum?: number; avg?: number; min?: number; max?: number; nulls: number }>;
  dates: Record<string, { min?: string; max?: string; nulls: number }>;
  yearLike: Record<string, { min?: number; max?: number; nulls: number }>;
  categoricals: Record<string, { distinct?: number; nulls: number }>;
}

export interface BreakdownResult {
  categoryCol: ColumnMeta;
  measureCol?: ColumnMeta;
  rows: { category: unknown; value: number; n: number }[];
  sourceTable: TableMeta;
}

export interface TimeSeriesResult {
  dateCol: ColumnMeta;
  measureCol?: ColumnMeta;
  granularity: "month" | "year";
  rows: { period: unknown; value: number; n: number }[];
  sourceTable: TableMeta;
}

export interface ScatterResult {
  colA: ColumnMeta;
  colB: ColumnMeta;
  sourceTable: TableMeta;
  rows: { x: number; y: number }[];
}

export interface DashboardAnalysis {
  allTables: TableMeta[];
  ranked: TableColumnProfile[];
  primary?: TableAggregateResult;
  supporting: TableAggregateResult[];
  /** The primary table's best category breakdown — a ranking (e.g. "revenue by category"). */
  categoryBreakdown?: BreakdownResult;
  /** A second, different categorical dimension on the primary table, when one exists — for chart diversity, not a near-duplicate of categoryBreakdown. */
  secondaryCategoryBreakdown?: BreakdownResult;
  /** A category breakdown from a supporting table (e.g. "payment method distribution") — broadens the story beyond the single primary table. */
  supportingBreakdown?: BreakdownResult;
  timeSeries?: TimeSeriesResult;
  /** Two independent measures on the primary table, sampled for a scatter — only when the table genuinely has 2+ real measures. */
  scatter?: ScatterResult;
  warnings: string[];
}

const num = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? v : undefined);
const str = (v: unknown): string | undefined => (typeof v === "string" && v.length > 0 ? v : undefined);

async function aggregateTable(table: TableMeta, profile: TableColumnProfile, dataset: DatasetContext, config: AppConfig, execute: QueryExecutor, warnings: string[]): Promise<TableAggregateResult | undefined> {
  const { measures, dates, yearLike, categoricalCandidates } = profile;
  const empty = (rowCount: number): TableAggregateResult => ({ table, profile, rowCount, measures: {}, dates: {}, yearLike: {}, categoricals: {} });

  if (measures.length === 0 && dates.length === 0 && yearLike.length === 0 && categoricalCandidates.length === 0) {
    // still worth a row count on its own (e.g. a pure lookup table) — a trivial COUNT(*) query.
    const { sql } = buildTableAggregateSql(table, { measures: [], dates: [], categoricals: [] });
    const res = await runDashboardQuery(sql, dataset, config, execute);
    if (!res) {
      warnings.push(`Could not compute statistics for "${table.name}".`);
      return undefined;
    }
    return empty(num(res.rows[0]?.row_count) ?? table.rowCount ?? 0);
  }

  const { sql, keys } = buildTableAggregateSql(table, { measures, dates, yearLike, categoricals: categoricalCandidates });
  const res = await runDashboardQuery(sql, dataset, config, execute);
  if (!res || res.rows.length === 0) {
    warnings.push(`Could not compute statistics for "${table.name}".`);
    return undefined;
  }
  const row = res.rows[0];
  const out = empty(num(row[keys.rowCountAlias]) ?? table.rowCount ?? 0);
  for (const [colName, k] of Object.entries(keys.measures)) {
    out.measures[colName] = { sum: num(row[k.sum]), avg: num(row[k.avg]), min: num(row[k.min]), max: num(row[k.max]), nulls: num(row[k.nulls]) ?? 0 };
  }
  for (const [colName, k] of Object.entries(keys.dates)) {
    out.dates[colName] = { min: str(row[k.min]), max: str(row[k.max]), nulls: num(row[k.nulls]) ?? 0 };
  }
  for (const [colName, k] of Object.entries(keys.yearLike)) {
    out.yearLike[colName] = { min: num(row[k.min]), max: num(row[k.max]), nulls: num(row[k.nulls]) ?? 0 };
  }
  for (const [colName, k] of Object.entries(keys.categoricals)) {
    out.categoricals[colName] = { distinct: num(row[k.distinct]), nulls: num(row[k.nulls]) ?? 0 };
  }
  return out;
}

/** Measure candidates ranked by richest non-null coverage first — the head is "the" measure, the rest are alternates (e.g. for a scatter). */
function rankMeasures(agg: TableAggregateResult): ColumnMeta[] {
  return agg.profile.measures.filter((c) => agg.measures[c.name]?.sum !== undefined).sort((a, b) => (agg.measures[a.name].nulls ?? Infinity) - (agg.measures[b.name].nulls ?? Infinity));
}

/** Best measure to pair with a breakdown/time-series query: the richest measure candidate (highest non-null coverage), or none. */
function bestMeasure(agg: TableAggregateResult): ColumnMeta | undefined {
  return rankMeasures(agg)[0];
}

/** Real-category columns ranked by distinct count ascending (fewer categories = a cleaner chart) — the head is "the" category, the rest are alternates for a second, different chart. */
function rankCategoricals(agg: TableAggregateResult): ColumnMeta[] {
  return agg.profile.categoricalCandidates
    .filter((c) => isRealCategory(agg.categoricals[c.name]?.distinct, agg.rowCount))
    .sort((a, b) => (agg.categoricals[a.name].distinct ?? Infinity) - (agg.categoricals[b.name].distinct ?? Infinity));
}

const MAX_SUPPORTING_TABLES = 3;
const BREAKDOWN_LIMIT = 12;
const TIME_SERIES_LIMIT = 60;
const SCATTER_SAMPLE_LIMIT = 300;

// The validator caps a single statement at LIMITS.maxTables (15) FROM clauses; a UNION-ALL branch per table counts
// as one each, so a wide schema (like the 20-table demo) must be split into chunks rather than sent as one query.
const ROW_COUNT_CHUNK_SIZE = 12;

/**
 * Every table's real row count, in as few round trips as the validator's table-count limit allows (see above) —
 * the registry's static rowCount is unreliable for the built-in demo, so ranking and totals must not depend on it
 * alone. On failure this just falls back to whatever the registry already has (0 for the demo, the real introspected
 * count for uploads).
 */
async function realRowCounts(tableNames: string[], dataset: DatasetContext, config: AppConfig, execute: QueryExecutor, warnings: string[]): Promise<Map<string, number>> {
  const map = new Map<string, number>();
  if (tableNames.length === 0) return map;
  const chunks: string[][] = [];
  for (let i = 0; i < tableNames.length; i += ROW_COUNT_CHUNK_SIZE) chunks.push(tableNames.slice(i, i + ROW_COUNT_CHUNK_SIZE));

  let anyFailed = false;
  for (const chunk of chunks) {
    const res = await runDashboardQuery(buildAllTableRowCountsSql(chunk), dataset, config, execute);
    if (!res) {
      anyFailed = true;
      continue;
    }
    for (const row of res.rows) {
      const name = typeof row.table_name === "string" ? row.table_name : undefined;
      const n = num(row.n);
      if (name && n !== undefined) map.set(name, n);
    }
  }
  if (anyFailed) warnings.push("Could not verify real row counts for every table; some totals may be approximate.");
  return map;
}

export async function analyzeDataset(dataset: DatasetContext, config: AppConfig, execute: QueryExecutor = executeQuery): Promise<DashboardAnalysis> {
  const warnings: string[] = [];
  const rowCounts = await realRowCounts(dataset.registry.tables.map((t) => t.name), dataset, config, execute, warnings);
  const allTables = dataset.registry.tables.map((t) => (rowCounts.has(t.name) ? { ...t, rowCount: rowCounts.get(t.name) } : t));
  const ranked = rankTables(allTables);
  if (ranked.length === 0) return { allTables, ranked, supporting: [], warnings };

  const [primaryProfile, ...rest] = ranked;
  const primary = await aggregateTable(primaryProfile.table, primaryProfile, dataset, config, execute, warnings);

  const supporting: TableAggregateResult[] = [];
  for (const p of rest.slice(0, MAX_SUPPORTING_TABLES)) {
    const agg = await aggregateTable(p.table, p, dataset, config, execute, warnings);
    if (agg) supporting.push(agg);
  }

  let categoryBreakdown: BreakdownResult | undefined;
  let secondaryCategoryBreakdown: BreakdownResult | undefined;
  let supportingBreakdown: BreakdownResult | undefined;
  let timeSeries: TimeSeriesResult | undefined;
  let scatter: ScatterResult | undefined;

  if (primary) {
    const measureCol = bestMeasure(primary);

    const dateCol = primary.profile.dates[0];
    if (dateCol) {
      const sql = buildTimeSeriesSql(primary.table, dateCol, measureCol, TIME_SERIES_LIMIT);
      const res = await runDashboardQuery(sql, dataset, config, execute);
      if (res) {
        timeSeries = { dateCol, measureCol, granularity: "month", sourceTable: primary.table, rows: res.rows.map((r) => ({ period: r.period, value: num(r.value) ?? 0, n: num(r.n) ?? 0 })) };
      } else warnings.push(`Could not compute a time series for "${primary.table.name}".`);
    } else if (primary.profile.yearLike[0]) {
      const yearCol = primary.profile.yearLike[0];
      const sql = buildYearBreakdownSql(primary.table, yearCol, measureCol, TIME_SERIES_LIMIT);
      const res = await runDashboardQuery(sql, dataset, config, execute);
      if (res) {
        timeSeries = { dateCol: yearCol, measureCol, granularity: "year", sourceTable: primary.table, rows: res.rows.map((r) => ({ period: r.period, value: num(r.value) ?? 0, n: num(r.n) ?? 0 })) };
      }
    }

    const categoricals = rankCategoricals(primary);
    if (categoricals[0]) {
      const sql = buildCategoryBreakdownSql(primary.table, categoricals[0], measureCol, BREAKDOWN_LIMIT);
      const res = await runDashboardQuery(sql, dataset, config, execute);
      if (res) {
        categoryBreakdown = { categoryCol: categoricals[0], measureCol, sourceTable: primary.table, rows: res.rows.map((r) => ({ category: r.category, value: num(r.value) ?? 0, n: num(r.n) ?? 0 })) };
      } else warnings.push(`Could not compute a category breakdown for "${primary.table.name}".`);
    }
    // A second, genuinely different dimension on the same table (e.g. "revenue by category" AND "orders by status") — chart
    // diversity per the master prompt, not "revenue by category" repeated with a different color.
    if (categoricals[1]) {
      const sql = buildCategoryBreakdownSql(primary.table, categoricals[1], measureCol, BREAKDOWN_LIMIT);
      const res = await runDashboardQuery(sql, dataset, config, execute);
      if (res) {
        secondaryCategoryBreakdown = { categoryCol: categoricals[1], measureCol, sourceTable: primary.table, rows: res.rows.map((r) => ({ category: r.category, value: num(r.value) ?? 0, n: num(r.n) ?? 0 })) };
      }
    }

    // Two independent measures on the same table → a relationship view (scatter), a structurally different chart from
    // any ranking/trend above.
    const measures = rankMeasures(primary);
    if (measures.length >= 2) {
      const sql = buildScatterSampleSql(primary.table, measures[0], measures[1], SCATTER_SAMPLE_LIMIT);
      const res = await runDashboardQuery(sql, dataset, config, execute);
      if (res) {
        const rows = res.rows.map((r) => ({ x: num(r.x), y: num(r.y) })).filter((r): r is { x: number; y: number } => r.x !== undefined && r.y !== undefined);
        if (rows.length >= 5) scatter = { colA: measures[0], colB: measures[1], sourceTable: primary.table, rows };
      }
    }
  }

  // One category breakdown from a supporting table too (e.g. "payment method distribution" when the primary table's
  // own dimensions are already used above) — broadens the story beyond a single table without an unbounded query count.
  for (const agg of supporting) {
    const cats = rankCategoricals(agg);
    if (!cats[0]) continue;
    const measureCol = bestMeasure(agg);
    const sql = buildCategoryBreakdownSql(agg.table, cats[0], measureCol, BREAKDOWN_LIMIT);
    const res = await runDashboardQuery(sql, dataset, config, execute);
    if (res && res.rows.length >= 2) {
      supportingBreakdown = { categoryCol: cats[0], measureCol, sourceTable: agg.table, rows: res.rows.map((r) => ({ category: r.category, value: num(r.value) ?? 0, n: num(r.n) ?? 0 })) };
      break;
    }
  }

  return { allTables, ranked, primary, supporting, categoryBreakdown, secondaryCategoryBreakdown, supportingBreakdown, timeSeries, scatter, warnings };
}
