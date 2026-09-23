import { describe, expect, it } from "vitest";
import { createDatasetContext } from "@/lib/datasets/context";
import { validateSql } from "@/lib/database/validator";
import { buildCategoryBreakdownSql, buildTableAggregateSql, buildTimeSeriesSql, buildYearBreakdownSql } from "@/lib/dashboard/sql-builder";
import { MOVIES_TABLE, ORDERS_TABLE } from "../helpers/dashboard-fixtures";

/**
 * Confirms the dashboard's own generated SQL passes through the SAME validator every LLM-generated query must pass
 * — no special-cased security bypass for app-generated aggregation SQL.
 */
const dataset = createDatasetContext({
  id: "ds_dashboard_fixture",
  name: "Fixture",
  sourceType: "sql",
  schemaName: "ds_dashboard_fixture",
  registry: { tables: [ORDERS_TABLE, MOVIES_TABLE], relationships: [], metrics: [], defaults: [] },
});

const [, customerId, orderDate, totalAmount, category] = ORDERS_TABLE.columns;
void customerId;

describe("dashboard SQL builder — generated SQL passes the real validator", () => {
  it("a combined table-aggregate query validates", async () => {
    const { sql } = buildTableAggregateSql(ORDERS_TABLE, { measures: [totalAmount], dates: [orderDate], categoricals: [category] });
    const result = await validateSql(sql, dataset);
    expect(result.valid, JSON.stringify(result.issues)).toBe(true);
    expect(result.tablesUsed).toEqual(["orders"]);
  });

  it("a category-breakdown query validates", async () => {
    const sql = buildCategoryBreakdownSql(ORDERS_TABLE, category, totalAmount, 12);
    const result = await validateSql(sql, dataset);
    expect(result.valid, JSON.stringify(result.issues)).toBe(true);
  });

  it("a time-series (DATE_TRUNC) query validates", async () => {
    const sql = buildTimeSeriesSql(ORDERS_TABLE, orderDate, totalAmount, 60);
    const result = await validateSql(sql, dataset);
    expect(result.valid, JSON.stringify(result.issues)).toBe(true);
  });

  it("a year-breakdown query validates", async () => {
    const releaseYear = MOVIES_TABLE.columns.find((c) => c.name === "release_year")!;
    const rating = MOVIES_TABLE.columns.find((c) => c.name === "rating")!;
    const sql = buildYearBreakdownSql(MOVIES_TABLE, releaseYear, rating, 60);
    const result = await validateSql(sql, dataset);
    expect(result.valid, JSON.stringify(result.issues)).toBe(true);
  });

  it("never references a table outside the dataset (safety smoke test)", async () => {
    const sql = buildTableAggregateSql(ORDERS_TABLE, { measures: [totalAmount], dates: [], categoricals: [] }).sql;
    expect(sql).not.toMatch(/pg_|information_schema/i);
  });
});
