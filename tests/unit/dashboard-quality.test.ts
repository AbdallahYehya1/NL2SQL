import { describe, expect, it } from "vitest";
import { buildQuality } from "@/lib/dashboard/quality-engine";
import { CUSTOMERS_TABLE, emptyAnalysis, fakeAgg, ORDERS_TABLE } from "../helpers/dashboard-fixtures";
import type { DashboardAnalysis } from "@/lib/dashboard/analyze";

describe("quality engine", () => {
  it("computes the exact NULL percentage for a column with known nulls", () => {
    const primary = fakeAgg(ORDERS_TABLE, { rowCount: 200, categoricals: { status: { distinct: 3, nulls: 20 } } });
    const analysis: DashboardAnalysis = { ...emptyAnalysis([ORDERS_TABLE]), primary, supporting: [] };
    const q = buildQuality(analysis);
    const col = q.columnsWithMissing.find((c) => c.column === "status");
    expect(col?.nullCount).toBe(20);
    expect(col?.nullPercent).toBe(10);
  });

  it("reports no missing columns and a clean coverage note when nothing is null", () => {
    const primary = fakeAgg(CUSTOMERS_TABLE, { rowCount: 60, categoricals: { city: { distinct: 10, nulls: 0 } } });
    const analysis: DashboardAnalysis = { ...emptyAnalysis([CUSTOMERS_TABLE]), primary, supporting: [] };
    const q = buildQuality(analysis);
    expect(q.columnsWithMissing).toEqual([]);
    expect(q.overallMissingPercent).toBe(0);
  });

  it("totals rows/columns/tables from the full registry, not just the analyzed subset", () => {
    const primary = fakeAgg(ORDERS_TABLE, { rowCount: 180 });
    const supporting = fakeAgg(CUSTOMERS_TABLE, { rowCount: 60 });
    const analysis: DashboardAnalysis = { ...emptyAnalysis([ORDERS_TABLE, CUSTOMERS_TABLE]), primary, supporting: [supporting] };
    const q = buildQuality(analysis);
    expect(q.totalRows).toBe(240);
    expect(q.totalTables).toBe(2);
    expect(q.totalColumns).toBe(ORDERS_TABLE.columns.length + CUSTOMERS_TABLE.columns.length);
  });

  it("honestly states coverage is partial when not every table was analyzed", () => {
    const primary = fakeAgg(ORDERS_TABLE, { rowCount: 180 });
    // Three tables in the registry, only one (primary) actually analyzed.
    const analysis: DashboardAnalysis = { ...emptyAnalysis([ORDERS_TABLE, CUSTOMERS_TABLE, { ...CUSTOMERS_TABLE, name: "products" }]), primary, supporting: [] };
    const q = buildQuality(analysis);
    expect(q.tablesAnalyzed).toBe(1);
    expect(q.coverageNote).toMatch(/1 most relevant of 3/);
  });

  it("does not crash on an empty dataset", () => {
    const q = buildQuality(emptyAnalysis([]));
    expect(q.totalRows).toBe(0);
    expect(q.overallMissingPercent).toBe(0);
    expect(q.columnsWithMissing).toEqual([]);
  });
});
