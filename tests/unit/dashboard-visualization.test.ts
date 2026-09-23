import { describe, expect, it } from "vitest";
import { buildVisualizations } from "@/lib/dashboard/visualization-engine";
import { emptyAnalysis, ORDERS_TABLE } from "../helpers/dashboard-fixtures";
import type { DashboardAnalysis } from "@/lib/dashboard/analyze";

describe("dashboard visualization engine — reuses the same detectVisualization used for query results", () => {
  it("turns a date+numeric time series into a line-shaped visualization", () => {
    const analysis: DashboardAnalysis = {
      ...emptyAnalysis([ORDERS_TABLE]),
      timeSeries: {
        dateCol: ORDERS_TABLE.columns[2],
        measureCol: ORDERS_TABLE.columns[3],
        granularity: "month",
        sourceTable: ORDERS_TABLE,
        rows: Array.from({ length: 6 }, (_, i) => ({ period: `2025-0${i + 1}-01`, value: 100 + i * 10, n: 5 })),
      },
    };
    const viz = buildVisualizations(analysis);
    const primary = viz.find((v) => v.id === "primary-time-series");
    expect(primary?.spec.type).toBe("line");
    expect(primary?.sourceTables).toEqual(["orders"]);
    expect(primary?.sourceColumns).toContain("order_date");
    expect(primary?.sourceColumns).toContain("total_amount");
  });

  it("turns a category+numeric breakdown into a bar-shaped visualization", () => {
    const analysis: DashboardAnalysis = {
      ...emptyAnalysis([ORDERS_TABLE]),
      categoryBreakdown: {
        categoryCol: ORDERS_TABLE.columns[4],
        measureCol: ORDERS_TABLE.columns[3],
        sourceTable: ORDERS_TABLE,
        rows: [
          { category: "Electronics", value: 500, n: 10 },
          { category: "Accessories", value: 300, n: 8 },
          { category: "Home", value: 150, n: 4 },
        ],
      },
    };
    const viz = buildVisualizations(analysis);
    const cat = viz.find((v) => v.id === "primary-category-breakdown");
    expect(["bar", "horizontal-bar"]).toContain(cat?.spec.type);
  });

  it("produces no visualization from an unsupported/near-empty shape", () => {
    const analysis: DashboardAnalysis = {
      ...emptyAnalysis([ORDERS_TABLE]),
      categoryBreakdown: { categoryCol: ORDERS_TABLE.columns[4], measureCol: undefined, sourceTable: ORDERS_TABLE, rows: [{ category: "Only one", value: 1, n: 1 }] },
    };
    expect(buildVisualizations(analysis)).toEqual([]);
  });

  it("returns no visualizations for an empty dataset without crashing", () => {
    expect(buildVisualizations(emptyAnalysis([]))).toEqual([]);
  });
});
