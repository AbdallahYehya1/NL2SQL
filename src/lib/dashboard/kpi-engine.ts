import { formatNumberCompact, formatNumberFull, looksLikeCurrency, titleCase } from "@/lib/format";
import { isRealCategory } from "./column-classify";
import type { DashboardAnalysis, TableAggregateResult } from "./analyze";
import type { DashboardKpi } from "./types";

/**
 * Deterministic KPI selection: every candidate below is only produced when the underlying column/aggregate genuinely
 * exists and returned a real (non-null) value — never a "$0 Revenue" placeholder for a dataset with no currency
 * column. Candidates are scored by `priority` and the top 4–6 are kept (see `selectKpis`).
 */

const round2 = (n: number) => Math.round(n * 100) / 100;

function currency(n: number): string {
  return `$${formatNumberCompact(n)}`;
}

/** Naive but adequate English pluralization for a KPI label derived from a single column/table name. */
function pluralize(word: string): string {
  if (/(s|sh|ch|x|z)$/i.test(word)) return `${word}es`;
  if (/[^aeiou]y$/i.test(word)) return `${word.slice(0, -1)}ies`;
  if (/s$/i.test(word)) return word;
  return `${word}s`;
}

function monthsBetween(minIso: string, maxIso: string): number {
  const a = new Date(minIso);
  const b = new Date(maxIso);
  return (b.getFullYear() - a.getFullYear()) * 12 + (b.getMonth() - a.getMonth());
}

function dateRangeLabel(minIso: string, maxIso: string): string {
  const months = monthsBetween(minIso, maxIso);
  if (months >= 24) return `${Math.round(months / 12)} years`;
  if (months >= 1) return `${months} month${months === 1 ? "" : "s"}`;
  const days = Math.max(0, Math.round((new Date(maxIso).getTime() - new Date(minIso).getTime()) / 86_400_000));
  return `${days} day${days === 1 ? "" : "s"}`;
}

function tableRowCountKpi(agg: TableAggregateResult, priority: number): DashboardKpi {
  // Table names are conventionally already plural in SQL ("orders", "customers") — label with the table name as-is,
  // never re-pluralized (pluralize() below is for column-derived labels, which are conventionally singular).
  return {
    id: `rows:${agg.table.name}`,
    label: titleCase(agg.table.name),
    value: formatNumberFull(agg.rowCount),
    rawValue: agg.rowCount,
    format: "number",
    sourceTables: [agg.table.name],
    sourceColumns: [],
    calculation: `COUNT(*) FROM ${agg.table.name}`,
    priority,
  };
}

function bestMeasureEntry(agg: TableAggregateResult): [string, { sum?: number; avg?: number; nulls: number }] | undefined {
  const entries = Object.entries(agg.measures).filter(([, v]) => v.sum !== undefined);
  if (entries.length === 0) return undefined;
  return entries.reduce((best, cur) => (cur[1].nulls < best[1].nulls ? cur : best));
}

function bestCategoricalEntry(agg: TableAggregateResult): [string, { distinct?: number }] | undefined {
  const entries = Object.entries(agg.categoricals).filter(([, v]) => isRealCategory(v.distinct, agg.rowCount));
  if (entries.length === 0) return undefined;
  return entries.reduce((best, cur) => ((cur[1].distinct ?? Infinity) < (best[1].distinct ?? Infinity) ? cur : best));
}

function buildCandidates(analysis: DashboardAnalysis): DashboardKpi[] {
  const candidates: DashboardKpi[] = [];
  const { primary, supporting } = analysis;
  if (!primary) return candidates;

  candidates.push(tableRowCountKpi(primary, 100));

  const measure = bestMeasureEntry(primary);
  if (measure) {
    const [colName, agg] = measure;
    const isCurrency = looksLikeCurrency(colName);
    if (agg.sum !== undefined) {
      candidates.push({
        id: `sum:${primary.table.name}.${colName}`,
        label: `Total ${titleCase(colName)}`,
        value: isCurrency ? currency(agg.sum) : formatNumberCompact(agg.sum),
        rawValue: agg.sum,
        format: isCurrency ? "currency" : "number",
        sourceTables: [primary.table.name],
        sourceColumns: [colName],
        calculation: `SUM(${primary.table.name}.${colName})`,
        priority: 90,
      });
    }
    if (agg.avg !== undefined) {
      candidates.push({
        id: `avg:${primary.table.name}.${colName}`,
        label: `Average ${titleCase(colName)}`,
        value: isCurrency ? currency(agg.avg) : formatNumberFull(round2(agg.avg)),
        rawValue: agg.avg,
        format: isCurrency ? "currency" : "number",
        sourceTables: [primary.table.name],
        sourceColumns: [colName],
        calculation: `AVG(${primary.table.name}.${colName})`,
        priority: 75,
      });
    }
  }

  const categorical = bestCategoricalEntry(primary);
  if (categorical) {
    const [colName, agg] = categorical;
    candidates.push({
      id: `distinct:${primary.table.name}.${colName}`,
      label: pluralize(titleCase(colName)),
      value: formatNumberFull(agg.distinct!),
      rawValue: agg.distinct,
      format: "number",
      sourceTables: [primary.table.name],
      sourceColumns: [colName],
      calculation: `COUNT(DISTINCT ${primary.table.name}.${colName})`,
      priority: 60,
    });
  }

  const dateEntry = Object.entries(primary.dates).find(([, v]) => v.min && v.max);
  const yearEntry = Object.entries(primary.yearLike).find(([, v]) => v.min !== undefined && v.max !== undefined);
  if (dateEntry) {
    const [colName, v] = dateEntry;
    candidates.push({
      id: `range:${primary.table.name}.${colName}`,
      label: `${titleCase(colName)} Range`,
      value: dateRangeLabel(v.min!, v.max!),
      format: "duration",
      sourceTables: [primary.table.name],
      sourceColumns: [colName],
      calculation: `MAX(${colName}) - MIN(${colName})`,
      priority: 55,
    });
  } else if (yearEntry) {
    const [colName, v] = yearEntry;
    const span = v.max! - v.min!;
    candidates.push({
      id: `range:${primary.table.name}.${colName}`,
      label: `${titleCase(colName)} Range`,
      value: v.min === v.max ? String(v.min) : `${v.min}–${v.max}`,
      description: span > 0 ? `${span} year${span === 1 ? "" : "s"}` : undefined,
      format: "number",
      sourceTables: [primary.table.name],
      sourceColumns: [colName],
      calculation: `MIN/MAX(${colName})`,
      priority: 55,
    });
  }

  supporting.forEach((agg, i) => candidates.push(tableRowCountKpi(agg, 40 - i * 5)));

  return candidates;
}

/** Picks the top 4–6 candidates by priority. Never pads with a meaningless metric just to hit a minimum. */
export function selectKpis(analysis: DashboardAnalysis, max = 6): DashboardKpi[] {
  return buildCandidates(analysis)
    .sort((a, b) => b.priority - a.priority)
    .slice(0, max);
}
