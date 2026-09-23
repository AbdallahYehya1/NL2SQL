"use client";

import type { VisualizationSpec } from "./detect";
import { BarChartView } from "./bar-chart-view";
import { DonutChartView } from "./donut-chart-view";
import { HorizontalBarChartView } from "./horizontal-bar-chart-view";
import { LineChartView } from "./line-chart-view";
import { ScatterChartView } from "./scatter-chart-view";

/** Dispatches a VisualizationSpec to the matching chart component. Returns null for "table"/"none" (caller shows the table). */
export function ChartRenderer({ spec, rows, heightPx }: { spec: VisualizationSpec; rows: Record<string, unknown>[]; heightPx?: number }) {
  switch (spec.type) {
    case "line":
      if (!spec.labelKey || !spec.valueKeys?.length) return null;
      return <LineChartView labelKey={spec.labelKey} valueKeys={spec.valueKeys} rows={rows} heightPx={heightPx} />;
    case "bar":
      if (!spec.labelKey || !spec.valueKeys?.length) return null;
      return <BarChartView labelKey={spec.labelKey} valueKeys={spec.valueKeys} rows={rows} heightPx={heightPx} />;
    case "horizontal-bar":
      if (!spec.labelKey || !spec.valueKeys?.length) return null;
      return <HorizontalBarChartView labelKey={spec.labelKey} valueKeys={spec.valueKeys} rows={rows} heightPx={heightPx} />;
    case "scatter":
      if (!spec.valueKeys || spec.valueKeys.length !== 2) return null;
      return <ScatterChartView valueKeys={[spec.valueKeys[0], spec.valueKeys[1]]} rows={rows} heightPx={heightPx} />;
    case "donut":
      if (!spec.labelKey || !spec.valueKeys?.[0]) return null;
      return <DonutChartView labelKey={spec.labelKey} valueKey={spec.valueKeys[0]} rows={rows} heightPx={heightPx} />;
    default:
      return null;
  }
}
