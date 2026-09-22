import { describe, expect, it } from "vitest";
import { formatRate, wilson95 } from "../evaluation/stats";

describe("Wilson 95% interval", () => {
  it("matches known values", () => {
    expect(wilson95(0, 0)).toBeNull();
    expect(wilson95(10, 10)).toEqual({ rate: 100, low: 72.2, high: 100 });
    expect(wilson95(0, 10)).toEqual({ rate: 0, low: 0, high: 27.8 });
    const w = wilson95(30, 40)!;
    expect(w.rate).toBe(75);
    expect(w.low).toBeGreaterThan(59);
    expect(w.high).toBeLessThan(86);
  });
  it("formats with the counts", () => {
    expect(formatRate(9, 10)).toMatch(/^9\/10 = 90% \(95% CI \d+(\.\d)?–\d+(\.\d)?%\)$/);
    expect(formatRate(0, 0)).toBe("n/a (0 cases)");
  });
});
