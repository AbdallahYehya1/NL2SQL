import { describe, expect, it } from "vitest";
import { buildInsights } from "@/lib/dashboard/insight-engine";
import { buildQuality } from "@/lib/dashboard/quality-engine";
import { CUSTOMERS_TABLE, emptyAnalysis, fakeAgg, ORDERS_TABLE } from "../helpers/dashboard-fixtures";
import type { DashboardAnalysis } from "@/lib/dashboard/analyze";

function monthlySeries(values: number[], startYear = 2025, startMonth = 1) {
  return values.map((value, i) => {
    const m = ((startMonth - 1 + i) % 12) + 1;
    const y = startYear + Math.floor((startMonth - 1 + i) / 12);
    return { period: `${y}-${String(m).padStart(2, "0")}-01`, value, n: 10 };
  });
}

describe("insight engine — peak / low", () => {
  it("finds the exact highest and lowest periods", () => {
    const rows = monthlySeries([100, 120, 90, 280, 150, 110]); // July-equivalent (index 3) is the peak
    const analysis: DashboardAnalysis = {
      ...emptyAnalysis([ORDERS_TABLE]),
      primary: fakeAgg(ORDERS_TABLE, { rowCount: 180 }),
      timeSeries: { dateCol: ORDERS_TABLE.columns[2], measureCol: undefined, granularity: "month", sourceTable: ORDERS_TABLE, rows },
    };
    const insights = buildInsights(analysis);
    const peak = insights.find((i) => i.type === "PEAK");
    const low = insights.find((i) => i.type === "LOW");
    expect(peak?.value).toBe(280);
    expect(peak?.statement).toContain("280");
    expect(low?.value).toBe(90);
  });
});

describe("insight engine — period labels never collapse across years (regression)", () => {
  it("a trend spanning more than one calendar year shows distinct start/end labels", () => {
    // 25 months starting Sep 2024 wraps back around to "September" for its last point (Sep 2026) — a label that
    // drops the year would render "Sep 1 through Sep 1", which is exactly the real bug found via live testing.
    const rows = monthlySeries(Array.from({ length: 25 }, (_, i) => 100 + i * 5), 2024, 9);
    const analysis: DashboardAnalysis = {
      ...emptyAnalysis([ORDERS_TABLE]),
      primary: fakeAgg(ORDERS_TABLE, { rowCount: 1000 }),
      timeSeries: { dateCol: ORDERS_TABLE.columns[2], measureCol: ORDERS_TABLE.columns[3], granularity: "month", sourceTable: ORDERS_TABLE, rows },
    };
    const trend = buildInsights(analysis).find((i) => i.type === "TREND");
    expect(trend!.statement).toContain("2024");
    expect(trend!.statement).toContain("2026");
    expect(trend!.period).not.toMatch(/^(\w+ \d+)–\1$/); // start and end must not render as the identical label
  });
});

describe("insight engine — trend", () => {
  it("detects a consistent upward trend with the correct direction and rough magnitude", () => {
    const rows = monthlySeries([100, 105, 115, 130, 150, 170, 190]);
    const analysis: DashboardAnalysis = {
      ...emptyAnalysis([ORDERS_TABLE]),
      primary: fakeAgg(ORDERS_TABLE, { rowCount: 180 }),
      timeSeries: { dateCol: ORDERS_TABLE.columns[2], measureCol: ORDERS_TABLE.columns[3], granularity: "month", sourceTable: ORDERS_TABLE, rows },
    };
    const trend = buildInsights(analysis).find((i) => i.type === "TREND");
    expect(trend).toBeDefined();
    expect(trend!.changePercent).toBeGreaterThan(0);
    expect(trend!.statement).toContain("increased");
  });

  it("does not report a trend for a flat/noisy series", () => {
    const rows = monthlySeries([100, 98, 102, 99, 101, 100, 103]);
    const analysis: DashboardAnalysis = {
      ...emptyAnalysis([ORDERS_TABLE]),
      primary: fakeAgg(ORDERS_TABLE, { rowCount: 180 }),
      timeSeries: { dateCol: ORDERS_TABLE.columns[2], measureCol: undefined, granularity: "month", sourceTable: ORDERS_TABLE, rows },
    };
    expect(buildInsights(analysis).some((i) => i.type === "TREND")).toBe(false);
  });
});

describe("insight engine — comparison / concentration / distribution", () => {
  const base: DashboardAnalysis = { ...emptyAnalysis([ORDERS_TABLE]), primary: fakeAgg(ORDERS_TABLE, { rowCount: 180 }) };

  it("reports a comparison when the top two categories are close but the leader is clearly ahead", () => {
    const analysis: DashboardAnalysis = {
      ...base,
      categoryBreakdown: { categoryCol: ORDERS_TABLE.columns[4], measureCol: ORDERS_TABLE.columns[3], sourceTable: ORDERS_TABLE, rows: [
        { category: "Electronics", value: 118_000, n: 40 },
        { category: "Accessories", value: 100_000, n: 60 },
      ] },
    };
    const comparison = buildInsights(analysis).find((i) => i.type === "COMPARISON");
    expect(comparison?.category).toBe("Electronics");
    expect(comparison?.changePercent).toBeCloseTo(18, 0);
  });

  it("never reports an extreme SUM-driven percentage as a 'comparison' (regression: a 7,119% claim from a volume artifact)", () => {
    // "delivered" has vastly more shipments than "in_transit" — a real value found via live testing — so their raw
    // SUM(shipping_cost) totals differ by orders of magnitude even though nothing about the actual cost is unusual.
    const analysis: DashboardAnalysis = {
      ...base,
      categoryBreakdown: {
        categoryCol: ORDERS_TABLE.columns[4],
        measureCol: ORDERS_TABLE.columns[3],
        sourceTable: ORDERS_TABLE,
        rows: [
          { category: "delivered", value: 72_000, n: 10_000 },
          { category: "in_transit", value: 1000, n: 5 },
        ],
      },
    };
    const insights = buildInsights(analysis);
    expect(insights.some((i) => i.type === "COMPARISON")).toBe(false);
    expect(insights.some((i) => i.statement.match(/\d{4,}%/))).toBe(false); // no 4+ digit percentage in any statement
  });

  it("reports a concentration when the top 3 of many categories dominate the total", () => {
    const rows = [
      { category: "A", value: 40, n: 5 },
      { category: "B", value: 30, n: 5 },
      { category: "C", value: 20, n: 5 },
      { category: "D", value: 2, n: 1 },
      { category: "E", value: 2, n: 1 },
      { category: "F", value: 2, n: 1 },
      { category: "G", value: 2, n: 1 },
      { category: "H", value: 2, n: 1 },
    ];
    const analysis: DashboardAnalysis = { ...base, categoryBreakdown: { categoryCol: ORDERS_TABLE.columns[4], measureCol: undefined, sourceTable: ORDERS_TABLE, rows } };
    const concentration = buildInsights(analysis).find((i) => i.type === "CONCENTRATION");
    expect(concentration).toBeDefined();
    expect(concentration!.value).toBeGreaterThanOrEqual(85);
  });

  it("produces no category insight from a perfectly even split", () => {
    const rows = [{ category: "A", value: 25, n: 1 }, { category: "B", value: 25, n: 1 }, { category: "C", value: 25, n: 1 }, { category: "D", value: 25, n: 1 }];
    const analysis: DashboardAnalysis = { ...base, categoryBreakdown: { categoryCol: ORDERS_TABLE.columns[4], measureCol: undefined, sourceTable: ORDERS_TABLE, rows } };
    expect(buildInsights(analysis).some((i) => ["COMPARISON", "CONCENTRATION", "DISTRIBUTION"].includes(i.type))).toBe(false);
  });
});

describe("insight engine — multiple breakdowns produce distinct, complementary insights", () => {
  it("draws separate insights from the primary, secondary, and supporting-table breakdowns rather than only the first", () => {
    const analysis: DashboardAnalysis = {
      ...emptyAnalysis([ORDERS_TABLE, CUSTOMERS_TABLE]),
      primary: fakeAgg(ORDERS_TABLE, { rowCount: 180 }),
      categoryBreakdown: { categoryCol: ORDERS_TABLE.columns[4], measureCol: ORDERS_TABLE.columns[3], sourceTable: ORDERS_TABLE, rows: [{ category: "Electronics", value: 500, n: 10 }, { category: "Accessories", value: 200, n: 8 }] },
      secondaryCategoryBreakdown: { categoryCol: ORDERS_TABLE.columns[5], measureCol: undefined, sourceTable: ORDERS_TABLE, rows: [{ category: "shipped", value: 140, n: 140 }, { category: "cancelled", value: 40, n: 40 }] },
      supportingBreakdown: { categoryCol: CUSTOMERS_TABLE.columns[2], measureCol: undefined, sourceTable: CUSTOMERS_TABLE, rows: [{ category: "Cairo", value: 50, n: 50 }, { category: "Paris", value: 10, n: 10 }] },
    };
    const insights = buildInsights(analysis);
    const tables = new Set(insights.flatMap((i) => i.sourceTables));
    expect(tables.has("customers")).toBe(true); // the supporting-table breakdown's insight must survive, not be crowded out
    const statements = insights.map((i) => i.statement);
    expect(new Set(statements).size).toBe(statements.length); // no two insights say the same thing
  });
});

describe("insight engine — data quality", () => {
  it("surfaces a DATA_QUALITY insight only when a column has a notable missing rate", () => {
    const primary = fakeAgg(ORDERS_TABLE, { rowCount: 1000, categoricals: { status: { distinct: 3, nulls: 320 } } });
    const analysis: DashboardAnalysis = { ...emptyAnalysis([ORDERS_TABLE]), primary, supporting: [] };
    const quality = buildQuality(analysis);
    const q = buildInsights(analysis, quality).find((i) => i.type === "DATA_QUALITY");
    expect(q).toBeDefined();
    expect(q!.statement).toContain("status");
    expect(q!.statement).toMatch(/3[0-9](\.\d)?%/);
  });

  it("produces no DATA_QUALITY insight when nothing is missing", () => {
    const primary = fakeAgg(CUSTOMERS_TABLE, { rowCount: 60, categoricals: { city: { distinct: 10, nulls: 0 } } });
    const analysis: DashboardAnalysis = { ...emptyAnalysis([CUSTOMERS_TABLE]), primary, supporting: [] };
    const quality = buildQuality(analysis);
    expect(buildInsights(analysis, quality).some((i) => i.type === "DATA_QUALITY")).toBe(false);
  });
});

describe("insight engine — selection cap and empty dataset", () => {
  it("never returns more than 5 insights", () => {
    const rows = monthlySeries([50, 300, 20, 60, 70, 80, 400, 30]);
    const analysis: DashboardAnalysis = {
      ...emptyAnalysis([ORDERS_TABLE]),
      primary: fakeAgg(ORDERS_TABLE, { rowCount: 1000, categoricals: { status: { distinct: 3, nulls: 500 } } }),
      timeSeries: { dateCol: ORDERS_TABLE.columns[2], measureCol: undefined, granularity: "month", sourceTable: ORDERS_TABLE, rows },
      categoryBreakdown: { categoryCol: ORDERS_TABLE.columns[4], measureCol: undefined, sourceTable: ORDERS_TABLE, rows: [{ category: "A", value: 90, n: 9 }, { category: "B", value: 5, n: 1 }, { category: "C", value: 5, n: 1 }] },
    };
    const quality = buildQuality(analysis);
    expect(buildInsights(analysis, quality).length).toBeLessThanOrEqual(5);
  });

  it("does not crash and returns no insights for an empty dataset", () => {
    expect(buildInsights(emptyAnalysis([]))).toEqual([]);
  });
});
