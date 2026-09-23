import { detectVisualization } from "@/components/charts/detect";
import { chartTitleFromColumns, titleCase } from "@/lib/format";
import type { DashboardAnalysis } from "./analyze";
import type { DashboardVisualizationData } from "./types";

/**
 * Reuses the SAME deterministic chart-type selection used for regular query results (detectVisualization) — the
 * dashboard doesn't get a second, parallel chart-picking system. Each candidate below comes from a structurally
 * different query analyze.ts already ran (time series, two different category breakdowns, a supporting-table
 * breakdown, a two-measure scatter), so the result is a genuinely diverse set of views — a trend, one or two
 * rankings, a distribution from elsewhere in the schema, and a relationship — rather than N near-duplicate charts.
 * `spec.type === "none"`/"table" is dropped rather than forced into a chart that wouldn't say anything; the total is
 * capped (see MAX_VISUALIZATIONS) so a data-rich dataset still gets a curated dashboard, not a wall of charts.
 */
const MAX_VISUALIZATIONS = 5;

export function buildVisualizations(analysis: DashboardAnalysis): DashboardVisualizationData[] {
  const out: DashboardVisualizationData[] = [];
  const { timeSeries, categoryBreakdown, secondaryCategoryBreakdown, supportingBreakdown, scatter } = analysis;

  if (timeSeries && timeSeries.rows.length >= 2) {
    const valueKey = timeSeries.measureCol?.name ?? "count";
    const rows = timeSeries.rows.map((r) => ({ period: r.period, [valueKey]: r.value }));
    const columns = ["period", valueKey];
    const spec = detectVisualization(columns, rows);
    if (spec.type !== "none" && spec.type !== "table") {
      out.push({
        id: "trend",
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

  const breakdownViz = (id: string, b: NonNullable<typeof categoryBreakdown>, descriptionPrefix: string) => {
    const catKey = b.categoryCol.name;
    const valueKey = b.measureCol?.name ?? "count";
    const rows = b.rows.map((r) => ({ [catKey]: r.category, [valueKey]: r.value }));
    const columns = [catKey, valueKey];
    const spec = detectVisualization(columns, rows);
    if (spec.type === "none" || spec.type === "table") return;
    out.push({
      id,
      title: chartTitleFromColumns(catKey, [valueKey]),
      description: `${descriptionPrefix} ${b.rows.length} ${catKey} groups from ${b.sourceTable.name}`,
      spec,
      columns,
      rows,
      sourceTables: [b.sourceTable.name],
      sourceColumns: [catKey, ...(b.measureCol ? [valueKey] : [])],
    });
  };

  if (categoryBreakdown && categoryBreakdown.rows.length >= 2) breakdownViz("ranking", categoryBreakdown, "");
  if (secondaryCategoryBreakdown && secondaryCategoryBreakdown.rows.length >= 2) breakdownViz("ranking-2", secondaryCategoryBreakdown, "");
  if (supportingBreakdown && supportingBreakdown.rows.length >= 2) breakdownViz("distribution", supportingBreakdown, "From elsewhere in the dataset:");

  if (scatter && scatter.rows.length >= 5) {
    // Real column names as the row keys (not generic "x"/"y") — ScatterChartView uses these keys directly as its axis
    // labels via titleCase(), so a generic key would show a meaningless "X"/"Y" axis instead of the real measure names.
    const aKey = scatter.colA.name;
    const bKey = scatter.colB.name;
    const rows = scatter.rows.map((r) => ({ [aKey]: r.x, [bKey]: r.y }));
    const columns = [aKey, bKey];
    const spec = detectVisualization(columns, rows);
    if (spec.type === "scatter") {
      out.push({
        id: "relationship",
        title: `${titleCase(bKey)} vs ${titleCase(aKey)}`,
        description: `${scatter.rows.length} records sampled from ${scatter.sourceTable.name}`,
        spec,
        columns,
        rows,
        sourceTables: [scatter.sourceTable.name],
        sourceColumns: [aKey, bKey],
      });
    }
  }

  return out.slice(0, MAX_VISUALIZATIONS);
}
