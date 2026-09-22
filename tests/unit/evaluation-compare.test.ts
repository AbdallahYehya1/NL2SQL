import { describe, expect, it } from "vitest";
import { compareResults, normaliseCell, shapeOk } from "../evaluation/compare";

describe("evaluation result comparison", () => {
  it("normalises numbers, numeric strings, timestamps and case", () => {
    expect(normaliseCell(1.234)).toBe("1.23");
    expect(normaliseCell("12")).toBe(normaliseCell(12));
    expect(normaliseCell("2026-08-01T00:00:00.000Z")).toBe("2026-08-01");
    expect(normaliseCell(" Computers ")).toBe("computers");
    expect(normaliseCell(null)).toBe("∅");
  });

  it("matches equal result sets regardless of aliases, column order and row order", () => {
    const gold = [{ category: "A", revenue: 10 }, { category: "B", revenue: 5 }];
    const actual = [{ rev: 5, cat: "B" }, { rev: 10, cat: "A" }];
    expect(compareResults(["category", "revenue"], gold, ["rev", "cat"], actual).match).toBe(true);
  });

  it("allows extra generated columns", () => {
    const gold = [{ n: 3 }];
    expect(compareResults(["n"], gold, ["n", "extra"], [{ n: 3, extra: "x" }]).match).toBe(true);
  });

  it("detects different values, row counts and misaligned rows", () => {
    expect(compareResults(["n"], [{ n: 3 }], ["n"], [{ n: 4 }]).match).toBe(false);
    expect(compareResults(["n"], [{ n: 3 }], ["n"], [{ n: 3 }, { n: 3 }]).reason).toContain("row count");
    const misaligned = compareResults(["a", "b"], [{ a: 1, b: "x" }, { a: 2, b: "y" }], ["a", "b"], [{ a: 1, b: "y" }, { a: 2, b: "x" }]);
    expect(misaligned.match).toBe(false);
  });

  it("checks shapes", () => {
    expect(shapeOk({ minRows: 1, maxRows: 3, minColumns: 2 }, ["a", "b"], [{ a: 1, b: 2 }]).match).toBe(true);
    expect(shapeOk({ minRows: 2, minColumns: 1 }, ["a"], [{ a: 1 }]).match).toBe(false);
    expect(shapeOk({ minRows: 0, maxRows: 1, minColumns: 1 }, ["a"], [{ a: 1 }, { a: 2 }]).match).toBe(false);
  });
});
