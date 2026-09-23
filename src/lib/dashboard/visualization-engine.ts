import { detectVisualization } from "@/components/charts/detect";
import { chartTitleFromColumns } from "@/lib/format";
import type { DashboardAnalysis } from "./analyze";
import type { DashboardVisualizationData } from "./types";

/**
 * Reuses the SAME deterministic chart-type selection used for regular query results (detectVisualization) — the
 * dashboard doesn't get a second, parallel chart-picking system. Only the two aggregation queries analyze.ts already
 * ran (time series, category breakdown) are turned into visualizations: no extra queries, no chart manufactured just
 * to fill space. `spec.type === "none"`/"table" is dropped rather than forced into a chart that wouldn't say anything.
 */
export function buildVisualizations(analysis: DashboardAnalysis): DashboardVisualizationData[] {
  const out: DashboardVisualizationData[] = [];
  const { timeSeries, categoryBreakdown } = analysis;

  if (timeSeries && timeSeries.rows.length >= 2) {
    const valueKey = timeSeries.measureCol?.name ?? "count";
    const rows = timeSeries.rows.map((r) => ({ period: r.period, [valueKey]: r.value }));
    const columns = ["period", valueKey];
    const spec = detectVisualization(columns, rows);
    if (spec.type !== "none" && spec.type !== "table") {
      out.push({
        id: "primary-time-series",
        title: chartTitleFromColumns("period", [valueKey]),
        description: `${timeSeries.rows.length} periods from ${timeSeries.sourceTable.name}.${timeSeries.dateCol.name}`,
        spec,
        columns,
        rows,
        sourceTables: [timeSeries.sourceTable.name],
        sourceColumns: [timeSeries.dateCol.name, ...(timeSeries.measureCol ? [timeSeries.measureCol.name] : [])],
      });
    }
  }

  if (categoryBreakdown && categoryBreakdown.rows.length >= 2) {
    const catKey = categoryBreakdown.categoryCol.name;
    const valueKey = categoryBreakdown.measureCol?.name ?? "count";
    const rows = categoryBreakdown.rows.map((r) => ({ [catKey]: r.category, [valueKey]: r.value }));
    const columns = [catKey, valueKey];
    const spec = detectVisualization(columns, rows);
    if (spec.type !== "none" && spec.type !== "table") {
      out.push({
        id: "primary-category-breakdown",
        title: chartTitleFromColumns(catKey, [valueKey]),
        description: `${categoryBreakdown.rows.length} ${catKey} groups from ${categoryBreakdown.sourceTable.name}`,
        spec,
        columns,
        rows,
        sourceTables: [categoryBreakdown.sourceTable.name],
        sourceColumns: [catKey, ...(categoryBreakdown.measureCol ? [valueKey] : [])],
      });
    }
  }

  return out;
}
