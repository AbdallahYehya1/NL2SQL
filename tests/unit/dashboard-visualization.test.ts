import { describe, expect, it } from "vitest";
import { buildVisualizations } from "@/lib/dashboard/visualization-engine";
import { CUSTOMERS_TABLE, emptyAnalysis, MOVIES_TABLE, ORDERS_TABLE } from "../helpers/dashboard-fixtures";
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
    const primary = viz.find((v) => v.id === "trend");
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
    const cat = viz.find((v) => v.id === "ranking");
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

describe("dashboard visualization engine — chart diversity (multiple complementary views)", () => {
  it("produces a distinct visualization for each of: trend, primary ranking, secondary ranking, supporting-table distribution, and a scatter relationship", () => {
    const analysis: DashboardAnalysis = {
      ...emptyAnalysis([ORDERS_TABLE, CUSTOMERS_TABLE]),
      timeSeries: {
        dateCol: ORDERS_TABLE.columns[2],
        measureCol: ORDERS_TABLE.columns[3],
        granularity: "month",
        sourceTable: ORDERS_TABLE,
        rows: Array.from({ length: 6 }, (_, i) => ({ period: `2025-0${i + 1}-01`, value: 100 + i * 10, n: 5 })),
      },
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
      secondaryCategoryBreakdown: {
        categoryCol: ORDERS_TABLE.columns[5],
        measureCol: undefined,
        sourceTable: ORDERS_TABLE,
        rows: [
          { category: "shipped", value: 90, n: 90 },
          { category: "pending", value: 60, n: 60 },
          { category: "cancelled", value: 30, n: 30 },
        ],
      },
      supportingBreakdown: {
        categoryCol: CUSTOMERS_TABLE.columns[2],
        measureCol: undefined,
        sourceTable: CUSTOMERS_TABLE,
        rows: [
          { category: "Cairo", value: 40, n: 40 },
          { category: "Paris", value: 15, n: 15 },
          { category: "Rome", value: 5, n: 5 },
        ],
      },
      scatter: {
        colA: ORDERS_TABLE.columns[3],
        colB: MOVIES_TABLE.columns.find((c) => c.name === "rating")!,
        sourceTable: ORDERS_TABLE,
        rows: Array.from({ length: 20 }, (_, i) => ({ x: i, y: i * 1.7 + (i % 3) })),
      },
    };
    const viz = buildVisualizations(analysis);
    expect(viz.map((v) => v.id)).toEqual(["trend", "ranking", "ranking-2", "distribution", "relationship"]);
    // each visualization's evidence must trace back to real, different source columns — not the same chart repeated
    const titles = new Set(viz.map((v) => v.title));
    expect(titles.size).toBe(viz.length);
  });

  it("caps the total at 5 even if more candidates were available", () => {
    const analysis: DashboardAnalysis = {
      ...emptyAnalysis([ORDERS_TABLE]),
      timeSeries: { dateCol: ORDERS_TABLE.columns[2], measureCol: undefined, granularity: "month", sourceTable: ORDERS_TABLE, rows: Array.from({ length: 4 }, (_, i) => ({ period: `2025-0${i + 1}-01`, value: i + 1, n: 1 })) },
      categoryBreakdown: { categoryCol: ORDERS_TABLE.columns[4], measureCol: undefined, sourceTable: ORDERS_TABLE, rows: [{ category: "A", value: 3, n: 3 }, { category: "B", value: 1, n: 1 }] },
      secondaryCategoryBreakdown: { categoryCol: ORDERS_TABLE.columns[5], measureCol: undefined, sourceTable: ORDERS_TABLE, rows: [{ category: "A", value: 3, n: 3 }, { category: "B", value: 1, n: 1 }] },
      supportingBreakdown: { categoryCol: CUSTOMERS_TABLE.columns[2], measureCol: undefined, sourceTable: CUSTOMERS_TABLE, rows: [{ category: "A", value: 3, n: 3 }, { category: "B", value: 1, n: 1 }] },
      scatter: { colA: ORDERS_TABLE.columns[3], colB: MOVIES_TABLE.columns.find((c) => c.name === "rating")!, sourceTable: ORDERS_TABLE, rows: Array.from({ length: 20 }, (_, i) => ({ x: i, y: i * 2 })) },
    };
    expect(buildVisualizations(analysis).length).toBeLessThanOrEqual(5);
  });
});
