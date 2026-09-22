import { afterAll, describe, expect, it } from "vitest";
import { pointAtTestDatabase } from "../helpers/db";
import { closePools } from "@/lib/database/client";
import { executeQuery } from "@/lib/database/executor";
import { toValidatedSql, validateSql } from "@/lib/database/validator";
import { BENCHMARK } from "../evaluation/benchmark";

pointAtTestDatabase();
afterAll(async () => {
  await closePools();
});

/**
 * Validates the benchmark itself: every reference query must pass the SQL validator, execute on the real
 * database, and produce the expected result shape. (Without this, "execution accuracy" against the gold
 * results would be meaningless.)
 */
describe("benchmark gold queries (real database)", () => {
  it("has at least 30 answerable cases with unique ids", () => {
    expect(BENCHMARK.length).toBeGreaterThanOrEqual(30);
    expect(new Set(BENCHMARK.map((c) => c.id)).size).toBe(BENCHMARK.length);
  });

  for (const c of BENCHMARK) {
    it(`${c.id}: validates, executes and matches the expected shape`, async () => {
      const validation = await validateSql(c.referenceSql);
      expect(validation.issues, "validator issues").toEqual([]);
      for (const t of c.expectedTables) expect(validation.tablesUsed, `expected table ${t}`).toContain(t);

      const res = await executeQuery({ sql: toValidatedSql(validation) });
      expect(res.success, res.success ? "" : JSON.stringify(res.error)).toBe(true);
      if (!res.success) return;
      expect(res.rows.length).toBeGreaterThanOrEqual(c.shape.minRows);
      if (c.shape.maxRows !== undefined) expect(res.rows.length).toBeLessThanOrEqual(c.shape.maxRows);
      expect(res.columns.length).toBeGreaterThanOrEqual(c.shape.minColumns);
    });
  }
});
