import type { ColumnMeta, TableMeta } from "@/lib/types";

/**
 * Classifies a column purely from its declared Postgres type string (`format_type()` output for uploads, the same
 * convention used by the curated demo registry — see src/lib/metadata/definitions.ts). No sampling, no guessing.
 */
export type ColumnKind = "numeric" | "date" | "categorical" | "boolean" | "other";

const NUMERIC_TYPE = /^(smallint|integer|bigint|decimal|numeric|real|double precision|money|int2|int4|int8|float4|float8|serial|bigserial)\b/i;
const DATE_TYPE = /^(timestamptz|timestamp|date|time|timetz)\b/i;
const BOOLEAN_TYPE = /^bool(ean)?\b/i;
const TEXT_TYPE = /^(text|character varying|varchar|character|char|bpchar|citext|uuid|name)\b/i;

export function classifyColumnType(pgType: string): ColumnKind {
  const t = (pgType ?? "").trim().toLowerCase();
  if (BOOLEAN_TYPE.test(t)) return "boolean";
  if (NUMERIC_TYPE.test(t)) return "numeric";
  if (DATE_TYPE.test(t)) return "date";
  if (TEXT_TYPE.test(t)) return "categorical";
  return "other";
}

/** A numeric column not marked as a key and not id/code-shaped by name — an actual measure, not an identifier. */
const ID_LIKE_NAME = /(^|_)(id|code|number|no|num)$/i;
const YEAR_LIKE_NAME = /(^|_)(year|month|day|week|quarter)$/i;

export function isMeasureCandidate(col: ColumnMeta): boolean {
  if (classifyColumnType(col.type) !== "numeric") return false;
  if (col.primaryKey || col.references) return false;
  if (ID_LIKE_NAME.test(col.name) || YEAR_LIKE_NAME.test(col.name)) return false; // a year/quarter number is a time dimension, not a summable quantity
  return true;
}

export function isDateCandidate(col: ColumnMeta): boolean {
  return classifyColumnType(col.type) === "date";
}

/** A "year" / "quarter" style integer column is a usable time dimension even though it's numeric, not a date type. */
export function isYearLikeCandidate(col: ColumnMeta): boolean {
  return classifyColumnType(col.type) === "numeric" && YEAR_LIKE_NAME.test(col.name) && !col.primaryKey && !col.references;
}

/**
 * A plain text attribute worth grouping by — not a key, not free text (name/description/email/url/id-shaped),
 * and not near-unique (which would make "distinct count" and "group by" both meaningless).
 */
const FREE_TEXT_NAME = /(name|title|description|desc|comment|note|email|url|address|phone|uuid)$/i;

export function isCategoricalCandidate(col: ColumnMeta, distinctCount: number | undefined, rowCount: number): boolean {
  if (classifyColumnType(col.type) !== "categorical" && classifyColumnType(col.type) !== "boolean") return false;
  if (col.primaryKey || col.references) return false;
  if (FREE_TEXT_NAME.test(col.name)) return false;
  if (distinctCount === undefined) return true; // unknown until queried — still a candidate, filtered later once we know
  return isRealCategory(distinctCount, rowCount);
}

/**
 * A genuine, groupable category, not a near-unique identifier/code column (a SKU or similar where distinct ≈ row
 * count) — used both to pick the "group by" column for charts/insights and the "distinct count" KPI, so a SKU-like
 * column never wins either by having a technically-small-but-still-meaningless distinct count relative to few rows.
 */
export function isRealCategory(distinctCount: number | undefined, rowCount: number): boolean {
  if (distinctCount === undefined || distinctCount <= 1) return false;
  if (rowCount > 0 && distinctCount / rowCount > 0.5) return false;
  return distinctCount <= 100;
}

export interface TableColumnProfile {
  table: TableMeta;
  measures: ColumnMeta[];
  dates: ColumnMeta[];
  yearLike: ColumnMeta[];
  categoricalCandidates: ColumnMeta[]; // type-eligible; distinct-count filtering happens once queried
}

export function profileTable(table: TableMeta): TableColumnProfile {
  return {
    table,
    measures: table.columns.filter(isMeasureCandidate),
    dates: table.columns.filter(isDateCandidate),
    yearLike: table.columns.filter(isYearLikeCandidate),
    categoricalCandidates: table.columns.filter((c) => classifyColumnType(c.type) === "categorical" && !c.primaryKey && !c.references && !FREE_TEXT_NAME.test(c.name)),
  };
}

/**
 * Ranks tables by how much they look like a "fact"/analytical table worth building the dashboard around. Row count
 * carries a heavy weight deliberately: in any real schema the transactional/fact table (order line items, event
 * logs, sales) has orders of magnitude more rows than a catalog/dimension table (products, categories) — that gap
 * is one of the most reliable, dataset-agnostic signals for "this is the table people actually want to analyze",
 * and needs a weight large enough that a ~2-order-of-magnitude row-count difference decides the ranking even when
 * the smaller table happens to also have its own date column (verified against the real demo schema, where a plain
 * per-column-type weighting alone left "products" and "order_items" within a fraction of a point of each other).
 */
export function scoreTable(p: TableColumnProfile): number {
  const rows = p.table.rowCount ?? 0;
  const base = p.measures.length * 3 + (p.dates.length > 0 || p.yearLike.length > 0 ? 3 : 0) + Math.min(p.categoricalCandidates.length, 3) + Math.log10(rows + 1) * 1.5;
  // A table with measures but NO date/year/categorical dimension at all cannot drive a time series, a category
  // breakdown, or most InsightFact types — it can still be useful as a supporting row-count/measure KPI, but should
  // not win the PRIMARY slot over a smaller table that actually has something to group or chart by.
  const hasDimension = p.dates.length > 0 || p.yearLike.length > 0 || p.categoricalCandidates.length > 0;
  return hasDimension ? base : base * 0.4;
}

export function rankTables(tables: TableMeta[]): TableColumnProfile[] {
  return tables.map(profileTable).sort((a, b) => scoreTable(b) - scoreTable(a));
}
