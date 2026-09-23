import { describe, expect, it } from "vitest";
import { detectKpi, detectVisualization } from "@/components/charts/detect";

describe("detectVisualization — deterministic chart selection from the result schema", () => {
  it("single KPI-shaped result (1 row, 1 numeric column) is not charted here — the KPI layer handles it, this stays table", () => {
    expect(detectVisualization(["total_customers"], [{ total_customers: 1800 }])).toMatchObject({ type: "table" });
  });

  it("date + numeric → line chart (time series)", () => {
    const rows = [
      { month: "2025-01-01", revenue: 1000 },
      { month: "2025-02-01", revenue: 1200 },
      { month: "2025-03-01", revenue: 1500 },
    ];
    expect(detectVisualization(["month", "revenue"], rows)).toEqual({ type: "line", labelKey: "month", valueKeys: ["revenue"], reason: expect.any(String) });
  });

  it("short category + numeric → bar chart", () => {
    const rows = [{ product: "A", sales: 120 }, { product: "B", sales: 240 }, { product: "C", sales: 180 }];
    expect(detectVisualization(["product", "sales"], rows)).toMatchObject({ type: "bar", labelKey: "product", valueKeys: ["sales"] });
  });

  it("many categories or long labels → horizontal bar for readability", () => {
    const rows = Array.from({ length: 15 }, (_, i) => ({ country: `Country Number ${i}`, revenue: 1000 + i }));
    expect(detectVisualization(["country", "revenue"], rows)).toMatchObject({ type: "horizontal-bar" });
  });

  it("two independent numeric dimensions → scatter", () => {
    const rows = [
      { age: 23, income: 1200 }, { age: 31, income: 2400 }, { age: 45, income: 5000 }, { age: 29, income: 1800 }, { age: 50, income: 6200 },
    ];
    expect(detectVisualization(["age", "income"], rows)).toMatchObject({ type: "scatter", valueKeys: ["age", "income"] });
  });

  it("small part-to-whole breakdown (named as a share/percentage) → donut", () => {
    const rows = [{ channel: "Organic", percentage: 40 }, { channel: "Paid", percentage: 35 }, { channel: "Referral", percentage: 25 }];
    expect(detectVisualization(["channel", "percentage"], rows)).toMatchObject({ type: "donut" });
  });

  it("the SAME shape without a part-to-whole name stays a bar chart (never assumes a whole)", () => {
    const rows = [{ product: "A", units: 40 }, { product: "B", units: 35 }, { product: "C", units: 25 }];
    expect(detectVisualization(["product", "units"], rows)).toMatchObject({ type: "bar" });
  });

  it("a detail record (mostly identifiers/strings) → table, not forced into a chart", () => {
    const rows = [
      { customer_id: 1, name: "A", email: "a@x.com", phone: "1" },
      { customer_id: 2, name: "B", email: "b@x.com", phone: "2" },
      { customer_id: 3, name: "C", email: "c@x.com", phone: "3" },
    ];
    expect(detectVisualization(["customer_id", "name", "email", "phone"], rows)).toMatchObject({ type: "table" });
  });

  it("empty result → none (not a table, not a chart)", () => {
    expect(detectVisualization(["a", "b"], [])).toMatchObject({ type: "none" });
    expect(detectVisualization([], [])).toMatchObject({ type: "none" });
  });

  it("more than 6 columns → table even if some are numeric", () => {
    const rows = [{ a: 1, b: 2, c: 3, d: 4, e: 5, f: 6, g: 7 }, { a: 2, b: 3, c: 4, d: 5, e: 6, f: 7, g: 8 }];
    expect(detectVisualization(["a", "b", "c", "d", "e", "f", "g"], rows)).toMatchObject({ type: "table" });
  });

  it("is defensive against null/undefined/NaN/mixed types and never throws", () => {
    expect(() => detectVisualization(["a", "b"], [{ a: null, b: undefined }, { a: NaN, b: "x" }])).not.toThrow();
    expect(() => detectVisualization(undefined as unknown as string[], undefined as unknown as Record<string, unknown>[])).not.toThrow();
    expect(() => detectVisualization(["a"], [null as unknown as Record<string, unknown>])).not.toThrow();
    expect(detectVisualization(["a", "b"], [{ a: 1, b: Infinity }, { a: 2, b: -Infinity }])).toMatchObject({ type: "table" });
  });
});

describe("detectKpi — a single headline metric, never fabricated", () => {
  it("exactly one row, one numeric column → KPI", () => {
    expect(detectKpi(["total_customers"], [{ total_customers: 1800 }])).toEqual({ valueKey: "total_customers", value: 1800 });
  });

  it("carries a label column when present", () => {
    expect(detectKpi(["name", "revenue"], [{ name: "Acme", revenue: 42000 }])).toEqual({ valueKey: "revenue", value: 42000, labelKey: "name", label: "Acme" });
  });

  it("only reports a delta when the backend itself provided a delta-shaped column — never computes one", () => {
    const withDelta = detectKpi(["revenue", "revenue_change_pct"], [{ revenue: 42000, revenue_change_pct: 12.3 }]);
    expect(withDelta).toEqual({ valueKey: "revenue", value: 42000, deltaKey: "revenue_change_pct", delta: 12.3 });
    const withoutDelta = detectKpi(["revenue"], [{ revenue: 42000 }]);
    expect(withoutDelta?.delta).toBeUndefined();
    expect(withoutDelta?.deltaKey).toBeUndefined();
  });

  it("more than one row → no KPI (there is no single 'the' number)", () => {
    expect(detectKpi(["x"], [{ x: 1 }, { x: 2 }])).toBeUndefined();
  });

  it("no usable numeric column → no KPI", () => {
    expect(detectKpi(["name"], [{ name: "Acme" }])).toBeUndefined();
    expect(detectKpi(["id"], [{ id: 7 }])).toBeUndefined(); // id-like column excluded
  });

  it("is defensive against empty/malformed input", () => {
    expect(detectKpi([], [])).toBeUndefined();
    expect(detectKpi(["x"], [null as unknown as Record<string, unknown>])).toBeUndefined();
    expect(detectKpi(["x"], [{ x: NaN }])).toBeUndefined();
  });
});
