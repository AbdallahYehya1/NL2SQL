import { describe, expect, it } from "vitest";
import { selectKpis } from "@/lib/dashboard/kpi-engine";
import { CUSTOMERS_TABLE, emptyAnalysis, fakeAgg, MOVIES_TABLE, ORDERS_TABLE } from "../helpers/dashboard-fixtures";

describe("KPI engine — numeric dataset (e-commerce-shaped)", () => {
  const primary = fakeAgg(ORDERS_TABLE, {
    rowCount: 180,
    measures: { total_amount: { sum: 284_600, avg: 1581.11, min: 5, max: 9999, nulls: 0 } },
    dates: { order_date: { min: "2024-01-01T00:00:00.000Z", max: "2025-07-01T00:00:00.000Z", nulls: 0 } },
    categoricals: { status: { distinct: 4, nulls: 0 }, category: { distinct: 6, nulls: 0 } },
  });
  const customers = fakeAgg(CUSTOMERS_TABLE, { rowCount: 60 });
  const analysis = { ...emptyAnalysis([ORDERS_TABLE, CUSTOMERS_TABLE]), primary, supporting: [customers] };

  it("computes the correct sum and average for the measure column", () => {
    const kpis = selectKpis(analysis);
    const total = kpis.find((k) => k.id.startsWith("sum:"));
    const avg = kpis.find((k) => k.id.startsWith("avg:"));
    expect(total?.rawValue).toBe(284_600);
    expect(total?.format).toBe("currency"); // "total_amount" ends in "amount" -> currency-shaped
    expect(avg?.rawValue).toBeCloseTo(1581.11);
  });

  it("picks the row count of the richest (primary) table, not a generic total", () => {
    const kpis = selectKpis(analysis);
    expect(kpis.find((k) => k.id === "rows:orders")?.rawValue).toBe(180);
  });

  it("includes a supporting-table row count", () => {
    const kpis = selectKpis(analysis);
    expect(kpis.find((k) => k.id === "rows:customers")?.rawValue).toBe(60);
  });

  it("computes a date-range duration from real min/max dates", () => {
    const kpis = selectKpis(analysis);
    const range = kpis.find((k) => k.id.startsWith("range:"));
    expect(range?.value).toMatch(/month|year/);
  });

  it("selects the smallest reasonable categorical column (status: 4) over the wider one (category: 6)", () => {
    const kpis = selectKpis(analysis);
    const distinctKpi = kpis.find((k) => k.id.startsWith("distinct:"));
    expect(distinctKpi?.rawValue).toBe(4);
  });

  it("never returns more than 6 KPIs", () => {
    expect(selectKpis(analysis).length).toBeLessThanOrEqual(6);
  });
});

describe("KPI engine — movie dataset (no currency, no revenue-shaped column)", () => {
  const primary = fakeAgg(MOVIES_TABLE, {
    rowCount: 1250,
    measures: { rating: { sum: 9250, avg: 7.4, min: 1.2, max: 9.8, nulls: 0 } },
    yearLike: { release_year: { min: 1975, max: 2017, nulls: 0 } },
    categoricals: { genre: { distinct: 18, nulls: 0 } },
  });
  const analysis = { ...emptyAnalysis([MOVIES_TABLE]), primary, supporting: [] };

  it("never fabricates a currency KPI when no currency-shaped column exists", () => {
    const kpis = selectKpis(analysis);
    expect(kpis.some((k) => k.format === "currency")).toBe(false);
  });

  it("computes the correct average rating", () => {
    const kpis = selectKpis(analysis);
    expect(kpis.find((k) => k.id.startsWith("avg:"))?.rawValue).toBeCloseTo(7.4);
  });

  it("uses the year-like column for a range KPI when there is no real date column", () => {
    const kpis = selectKpis(analysis);
    const range = kpis.find((k) => k.id.startsWith("range:"));
    expect(range?.value).toBe("1975–2017");
  });

  it("reports the genre distinct count", () => {
    const kpis = selectKpis(analysis);
    expect(kpis.find((k) => k.id.startsWith("distinct:"))?.rawValue).toBe(18);
  });
});

describe("KPI engine — no numeric / no date fields", () => {
  it("does not attempt a numeric KPI when there is no measure column", () => {
    const primary = fakeAgg(CUSTOMERS_TABLE, { rowCount: 60, categoricals: { city: { distinct: 12, nulls: 0 } } });
    const analysis = { ...emptyAnalysis([CUSTOMERS_TABLE]), primary, supporting: [] };
    const kpis = selectKpis(analysis);
    expect(kpis.some((k) => k.id.startsWith("sum:") || k.id.startsWith("avg:"))).toBe(false);
  });

  it("does not attempt a date-range KPI when there is no date/year column", () => {
    const primary = fakeAgg(CUSTOMERS_TABLE, { rowCount: 60 });
    const analysis = { ...emptyAnalysis([CUSTOMERS_TABLE]), primary, supporting: [] };
    const kpis = selectKpis(analysis);
    expect(kpis.some((k) => k.id.startsWith("range:"))).toBe(false);
  });
});

describe("KPI engine — empty dataset", () => {
  it("does not crash and returns no KPIs", () => {
    expect(selectKpis(emptyAnalysis([]))).toEqual([]);
  });
});
