/** Result comparison helpers for the NL2SQL evaluation (execution accuracy against gold results). */

type Row = Record<string, unknown>;

/** Normalise a cell so equivalent values compare equal (rounding, casing, midnight timestamps → dates). */
export function normaliseCell(v: unknown): string {
  if (v === null || v === undefined) return "∅";
  if (typeof v === "number") return (Math.round(v * 100) / 100).toFixed(2);
  if (typeof v === "boolean") return v ? "true" : "false";
  const s = String(v).trim();
  const iso = s.match(/^(\d{4}-\d{2}-\d{2})T00:00:00(?:\.000)?Z?$/);
  if (iso) return iso[1];
  if (/^-?\d+(\.\d+)?$/.test(s)) return (Math.round(Number(s) * 100) / 100).toFixed(2);
  return s.toLowerCase();
}

export interface CompareOutcome {
  match: boolean;
  reason: string;
}

/**
 * The generated result matches the gold result when the same number of rows is returned and every gold column
 * appears (by values, in any position and under any alias) among the generated columns. Extra generated columns are
 * allowed; row order is ignored.
 */
export function compareResults(goldCols: string[], goldRows: Row[], actCols: string[], actRows: Row[]): CompareOutcome {
  if (goldRows.length !== actRows.length) return { match: false, reason: `row count ${actRows.length} ≠ expected ${goldRows.length}` };
  if (goldRows.length === 0) return { match: true, reason: "both empty" };

  const goldProjected = goldRows.map((r) => goldCols.map((c) => normaliseCell(r[c])));
  const used = new Set<string>();
  const mapping: string[] = [];
  for (let j = 0; j < goldCols.length; j++) {
    const goldValues = goldProjected.map((r) => r[j]).sort();
    const candidate = actCols.find((ac) => !used.has(ac) && JSON.stringify(actRows.map((r) => normaliseCell(r[ac])).sort()) === JSON.stringify(goldValues));
    if (!candidate) return { match: false, reason: `no generated column matches expected column "${goldCols[j]}"` };
    used.add(candidate);
    mapping.push(candidate);
  }
  // rows must line up across the matched columns (same combinations), order-insensitive
  const a = goldProjected.map((r) => r.join("␟")).sort();
  const b = actRows.map((r) => mapping.map((c) => normaliseCell(r[c])).join("␟")).sort();
  return JSON.stringify(a) === JSON.stringify(b) ? { match: true, reason: "result sets are equal" } : { match: false, reason: "values match per column but rows do not line up" };
}

export function shapeOk(shape: { minRows: number; maxRows?: number; minColumns: number }, cols: string[], rows: Row[]): CompareOutcome {
  if (rows.length < shape.minRows) return { match: false, reason: `only ${rows.length} rows (min ${shape.minRows})` };
  if (shape.maxRows !== undefined && rows.length > shape.maxRows) return { match: false, reason: `${rows.length} rows (max ${shape.maxRows})` };
  if (cols.length < shape.minColumns) return { match: false, reason: `only ${cols.length} columns (min ${shape.minColumns})` };
  return { match: true, reason: "shape ok" };
}
