import { getBuiltinContext, type DatasetContext } from "@/lib/datasets/context";
import type { RetrievedItem, RoutingResult } from "@/lib/types";

/**
 * Stage 2/3 — semantic routing: turn scored metadata items into a small, connected set of tables.
 *
 *   scored items ──► table scores ──► top tables (+ tables required by matched metrics)
 *                                  └► relationship expansion: add the FK "bridge" tables that connect them
 */

export const MAX_SELECTED_TABLES = 5;
const MAX_BRIDGES = 2;
const METRIC_MATCH_THRESHOLD = 0.5;
const RELATIVE_TABLE_THRESHOLD = 0.4;
const ABSOLUTE_TABLE_THRESHOLD = 0.25;
const STRONG_COLUMN_SCORE = 0.6;

export function scoreTables(items: RetrievedItem[], dataset: DatasetContext = getBuiltinContext()): { table: string; score: number }[] {
  const raw = new Map<string, number>();
  const bump = (table: string | undefined, v: number) => {
    if (!table) return;
    raw.set(table, (raw.get(table) ?? 0) + v);
  };

  const colScores = new Map<string, number[]>();
  const metricBoost = new Map<string, number>();
  for (const it of items) {
    if (it.kind === "table") bump(it.table, it.score);
    else if (it.kind === "column" && it.table) {
      const arr = colScores.get(it.table) ?? [];
      arr.push(it.score);
      colScores.set(it.table, arr);
    } else if (it.kind === "metric" && it.metric && it.score >= 0.3) {
      for (const t of dataset.index.getMetric(it.metric)?.tables ?? []) metricBoost.set(t, Math.max(metricBoost.get(t) ?? 0, it.score * 0.7));
    }
  }
  for (const [table, scores] of colScores) {
    const top = scores.sort((a, b) => b - a).slice(0, 3);
    bump(table, top.reduce((s, x) => s + x, 0) * 0.35);
  }
  for (const [table, v] of metricBoost) bump(table, v);

  const max = Math.max(0, ...raw.values());
  if (max === 0) return [];
  return [...raw]
    .map(([table, s]) => ({ table, score: s / max }))
    .sort((a, b) => b.score - a.score);
}

/** Shortest FK path from `from` to any table in `targets` (inclusive of both ends). */
function pathToSet(dataset: DatasetContext, from: string, targets: ReadonlySet<string>): string[] | undefined {
  if (targets.has(from)) return [from];
  const queue: string[][] = [[from]];
  const seen = new Set([from]);
  while (queue.length) {
    const path = queue.shift()!;
    for (const n of dataset.index.neighbours(path[path.length - 1])) {
      if (seen.has(n.table)) continue;
      const next = [...path, n.table];
      if (targets.has(n.table)) return next;
      seen.add(n.table);
      queue.push(next);
    }
  }
  return undefined;
}

export function route(
  items: RetrievedItem[],
  method: RoutingResult["method"] = "lexical",
  vectorUnavailableReason?: string,
  dataset: DatasetContext = getBuiltinContext(),
): RoutingResult {
  const tableScores = scoreTables(items, dataset);
  const matchedMetrics = items
    .filter((i) => i.kind === "metric" && i.metric && i.score >= METRIC_MATCH_THRESHOLD)
    .slice(0, 3)
    .map((i) => i.metric!);

  const selected: string[] = [];
  const top = tableScores[0]?.score ?? 0;
  for (const t of tableScores) {
    if (selected.length >= MAX_SELECTED_TABLES) break;
    if (selected.length === 0 || (t.score >= RELATIVE_TABLE_THRESHOLD * top && t.score >= ABSOLUTE_TABLE_THRESHOLD)) selected.push(t.table);
  }
  // Datasets without curated business metrics (every uploaded dataset) have no metric to pull the right tables in, so a table
  // holding a strongly matching COLUMN ("city", "salary") is relevant even if the table itself is not mentioned by name.
  for (const it of dataset.registry.metrics.length ? [] : items) {
    if (selected.length >= MAX_SELECTED_TABLES) break;
    if (it.kind === "column" && it.table && it.score >= STRONG_COLUMN_SCORE && !selected.includes(it.table)) selected.push(it.table);
  }
  // a matched metric needs its own tables (e.g. revenue → orders + order_items)
  for (const m of matchedMetrics.slice(0, 1)) {
    for (const t of dataset.index.getMetric(m)?.tables ?? []) if (!selected.includes(t)) selected.push(t);
  }

  // relationship expansion: connect every table to the growing component through FK bridges
  const component = new Set<string>();
  const finalSelected: string[] = [];
  const bridges: string[] = [];
  for (const table of selected) {
    if (component.size === 0) {
      component.add(table);
      finalSelected.push(table);
      continue;
    }
    const path = pathToSet(dataset, table, component);
    if (!path) continue; // unreachable → drop
    const newBridges = path.slice(1, -1).filter((t) => !component.has(t));
    if (newBridges.length > MAX_BRIDGES && !matchedMetrics.length) continue;
    for (const b of newBridges) {
      component.add(b);
      if (!selected.includes(b)) bridges.push(b);
    }
    component.add(table);
    finalSelected.push(table);
  }

  // Anything a bridge path added that is itself selected is a normal table, not a bridge.
  return {
    method,
    vectorUnavailableReason,
    items: items.slice(0, 40),
    tableScores: tableScores.slice(0, 12),
    selectedTables: finalSelected,
    bridgeTables: [...new Set(bridges)].filter((b) => !finalSelected.includes(b)),
    matchedMetrics,
  };
}
