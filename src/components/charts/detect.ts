/**
 * Deterministic visualization intent: decide whether a result is a KPI, a chart (and which kind), or a table.
 * Pure function of the result schema (columns + rows) — no LLM involved, per the "visualization intelligence" design.
 * Defensive throughout: never assumes rows[0] exists, never treats NaN/Infinity/null as a usable number.
 */

export type VisualizationType = "line" | "bar" | "horizontal-bar" | "scatter" | "donut" | "table" | "none";

export interface VisualizationSpec {
  type: VisualizationType;
  labelKey?: string;
  valueKeys?: string[];
  /** Column with numeric values, once identified as "the" measure (donut/scatter use this differently). */
  reason: string;
}

export interface KpiSpec {
  /** The numeric column to headline. */
  valueKey: string;
  value: number;
  /** A column that looks like a pre-computed delta (never invented — only used if the backend already provided one). */
  deltaKey?: string;
  delta?: number;
  /** Any short label column present alongside the metric (e.g. a single category name). */
  labelKey?: string;
  label?: string;
}

const ID_LIKE = /(^|_)(id|year|month|day|week|quarter)$/i;
const DELTA_LIKE = /(delta|change|growth|diff|variance)(_pct|_percent|_percentage)?$|_(pct|percent|percentage)_change$/i;

function isFiniteNumber(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v);
}

function isDateString(v: unknown): boolean {
  return typeof v === "string" && /^\d{4}-\d{2}(-\d{2})?(T\d{2}:\d{2}(:\d{2}(\.\d+)?)?Z?)?$/.test(v);
}

interface ColumnProfile {
  name: string;
  /** number, excluding NaN/Infinity, and excluding id/year/month-style integer columns. */
  numeric: boolean;
  /** numeric but excluded from "measure" candidates because the name looks like an identifier/date part. */
  idLike: boolean;
  date: boolean;
  string: boolean;
  distinctCount: number;
}

function profileColumns(columns: string[], rows: Record<string, unknown>[]): ColumnProfile[] {
  return columns.map((name) => {
    const values = rows.map((r) => r?.[name]).filter((v) => v !== null && v !== undefined);
    const allNumeric = values.length > 0 && values.every(isFiniteNumber);
    const allDate = values.length > 0 && values.every(isDateString);
    const allString = values.length > 0 && values.every((v) => typeof v === "string");
    return {
      name,
      numeric: allNumeric && !ID_LIKE.test(name),
      idLike: allNumeric && ID_LIKE.test(name),
      date: allDate && !allNumeric,
      string: allString && !allDate,
      distinctCount: new Set(values.map(String)).size,
    };
  });
}

/**
 * A headline single metric — surfaced as a KPI whenever the result is exactly one row with exactly one usable
 * numeric column. Deliberately conservative: with more than one row there is no single "the" number to headline,
 * so no KPI is produced (the visualization/table below still shows the full result).
 */
export function detectKpi(columns: string[], rows: Record<string, unknown>[]): KpiSpec | undefined {
  if (!Array.isArray(rows) || rows.length !== 1 || !Array.isArray(columns) || columns.length === 0) return undefined;
  const row = rows[0];
  if (!row || typeof row !== "object") return undefined;
  const profiles = profileColumns(columns, rows);
  const numericCols = profiles.filter((c) => c.numeric);
  if (numericCols.length === 0) return undefined;

  // Prefer a numeric column that isn't itself a delta as the headline; a delta column (if any) decorates it.
  const deltaCol = numericCols.find((c) => DELTA_LIKE.test(c.name));
  const headline = numericCols.find((c) => c !== deltaCol) ?? numericCols[0];
  const value = row[headline.name];
  if (!isFiniteNumber(value)) return undefined;

  const labelCol = profiles.find((c) => c.string);
  const spec: KpiSpec = { valueKey: headline.name, value };
  if (labelCol && typeof row[labelCol.name] === "string") {
    spec.labelKey = labelCol.name;
    spec.label = row[labelCol.name] as string;
  }
  if (deltaCol) {
    const dv = row[deltaCol.name];
    if (isFiniteNumber(dv)) {
      spec.deltaKey = deltaCol.name;
      spec.delta = dv;
    }
  }
  return spec;
}

const PART_TO_WHOLE_NAME = /percent|percentage|proportion|share|distribution|breakdown|ratio/i;

/**
 * Chart/table selection. Returns `{ type: "none" }` for empty results and `{ type: "table" }` whenever no chart
 * would communicate anything a table doesn't already — a good table beats a forced chart.
 */
export function detectVisualization(columns: string[], rows: Record<string, unknown>[]): VisualizationSpec {
  if (!Array.isArray(columns) || !Array.isArray(rows) || rows.length === 0) return { type: "none", reason: "empty result" };
  if (columns.length === 0) return { type: "none", reason: "no columns" };

  const profiles = profileColumns(columns, rows);
  const numeric = profiles.filter((c) => c.numeric);
  const dateCol = profiles.find((c) => c.date);
  const stringCols = profiles.filter((c) => c.string);
  const categoryCol = stringCols.find((c) => c.distinctCount <= Math.max(30, rows.length));

  // A single row was already handled by the KPI layer; still allow a chart underneath only if it's genuinely multi-row.
  if (rows.length < 2) return { type: "table", reason: "fewer than 2 rows" };

  // too many columns to make sense of visually (e.g. a wide detail record) → table
  if (columns.length > 6) return { type: "table", reason: "too many columns for a chart" };

  // Temporal + numeric → line chart (time series). No firm row cap; a long trend is still a line chart.
  if (dateCol && numeric.length >= 1 && numeric.length <= 3 && rows.length <= 400) {
    return { type: "line", labelKey: dateCol.name, valueKeys: numeric.map((c) => c.name), reason: "date column + numeric" };
  }

  // Two numeric dimensions, no category/date to group by → scatter (point-like data), only when there are enough points.
  if (!categoryCol && !dateCol && numeric.length === 2 && rows.length >= 5 && rows.length <= 500) {
    return { type: "scatter", valueKeys: numeric.map((c) => c.name), reason: "two independent numeric columns" };
  }

  // Category + exactly one numeric column: bar / horizontal-bar / donut, depending on shape.
  if (categoryCol && numeric.length >= 1 && numeric.length <= 4 && rows.length <= 60) {
    const singleMeasure = numeric.length === 1;
    const isPartToWhole = singleMeasure && rows.length <= 6 && PART_TO_WHOLE_NAME.test(numeric[0].name) && rows.every((r) => {
      const v = r[numeric[0].name];
      return isFiniteNumber(v) && v >= 0;
    });
    if (isPartToWhole) return { type: "donut", labelKey: categoryCol.name, valueKeys: [numeric[0].name], reason: "small part-to-whole breakdown" };

    const avgLabelLen = rows.reduce((sum, r) => sum + String(r[categoryCol.name] ?? "").length, 0) / rows.length;
    const longLabels = avgLabelLen > 10 || rows.length > 8;
    return {
      type: longLabels ? "horizontal-bar" : "bar",
      labelKey: categoryCol.name,
      valueKeys: numeric.slice(0, 4).map((c) => c.name),
      reason: longLabels ? "category + numeric, long labels or many categories" : "category + numeric",
    };
  }

  return { type: "table", reason: "no clear chart shape" };
}
