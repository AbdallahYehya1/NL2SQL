import { describe, expect, it } from "vitest";
import { classifyColumnType, isCategoricalCandidate, isDateCandidate, isMeasureCandidate, isYearLikeCandidate, rankTables } from "@/lib/dashboard/column-classify";
import { CUSTOMERS_TABLE, MOVIES_TABLE, ORDERS_TABLE } from "../helpers/dashboard-fixtures";

describe("classifyColumnType", () => {
  it.each([
    ["integer", "numeric"],
    ["bigint", "numeric"],
    ["numeric(12,2)", "numeric"],
    ["real", "numeric"],
    ["timestamptz", "date"],
    ["timestamp without time zone", "date"],
    ["date", "date"],
    ["text", "categorical"],
    ["character varying(255)", "categorical"],
    ["boolean", "boolean"],
    ["jsonb", "other"],
  ] as const)("%s -> %s", (type, expected) => {
    expect(classifyColumnType(type)).toBe(expected);
  });
});

describe("column candidacy", () => {
  const [id, customerId, orderDate, totalAmount, category] = ORDERS_TABLE.columns;

  it("excludes a primary key from measure candidacy even though it's numeric", () => {
    expect(isMeasureCandidate(id)).toBe(false);
  });
  it("excludes a foreign key from measure candidacy", () => {
    expect(isMeasureCandidate(customerId)).toBe(false);
  });
  it("accepts a real numeric measure", () => {
    expect(isMeasureCandidate(totalAmount)).toBe(true);
  });
  it("recognises a real date column", () => {
    expect(isDateCandidate(orderDate)).toBe(true);
    expect(isDateCandidate(totalAmount)).toBe(false);
  });
  it("recognises a year-shaped integer column, and excludes it from measures", () => {
    const releaseYear = MOVIES_TABLE.columns.find((c) => c.name === "release_year")!;
    expect(isYearLikeCandidate(releaseYear)).toBe(true);
    expect(isMeasureCandidate(releaseYear)).toBe(false);
  });
  it("treats a plain text attribute as a categorical candidate but not a free-text/id-shaped one", () => {
    expect(isCategoricalCandidate(category, 6, 180)).toBe(true);
    expect(isCategoricalCandidate(category, 179, 180)).toBe(false); // near-unique -> not a real category
  });
});

describe("rankTables", () => {
  it("ranks a table with measures+dates above a pure lookup table, even with fewer rows", () => {
    const lookup = { ...CUSTOMERS_TABLE, rowCount: 1_000_000, columns: [CUSTOMERS_TABLE.columns[0], CUSTOMERS_TABLE.columns[1]] }; // id + name only
    const ranked = rankTables([lookup, ORDERS_TABLE]);
    expect(ranked[0].table.name).toBe("orders");
  });

  it("does not crash on an empty table list", () => {
    expect(rankTables([])).toEqual([]);
  });
});
