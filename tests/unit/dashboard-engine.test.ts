import { describe, expect, it } from "vitest";
import { loadConfig } from "@/lib/config";
import { buildDashboard } from "@/lib/dashboard/engine";
import type { QueryExecutor } from "@/lib/dashboard/query-runner";
import { getBuiltinContext } from "@/lib/datasets/context";
import type { ExecutionResult } from "@/lib/types";

/**
 * A generic fake executor: reads the SELECT list's own aliases (which analyze.ts/sql-builder.ts generate in a
 * predictable shape — see the *_sum/_avg/_min/_max/_distinct/_nulls suffixes) and fabricates plausible values for
 * each, so this test exercises the FULL buildDashboard pipeline against the real 20-table demo schema without a
 * live database, and without hand-coding which table/column the ranking engine happens to pick.
 */
function fakeExecutor(): QueryExecutor {
  return (async ({ sql }) => {
    const aliases = [...sql.matchAll(/AS "([a-zA-Z0-9_]+)"/g)].map((m) => m[1]);
    const grouped = /GROUP BY/i.test(sql);
    const valueFor = (alias: string, i: number): unknown => {
      if (alias === "row_count") return 100;
      if (alias.endsWith("_nulls")) return 2;
      if (alias.endsWith("_sum")) return 50_000 + i * 1000;
      if (alias.endsWith("_avg")) return 500 + i * 10;
      if (alias.endsWith("_min")) return alias.startsWith("d_") ? "2024-01-01T00:00:00.000Z" : 10;
      if (alias.endsWith("_max")) return alias.startsWith("d_") ? "2025-06-01T00:00:00.000Z" : 99;
      if (alias.endsWith("_distinct")) return 5;
      if (alias === "value") return 1000 + i * 50;
      if (alias === "n") return 10;
      return 1;
    };
    const buildRow = (i: number) => {
      const row: Record<string, unknown> = {};
      for (const a of aliases) {
        if (a === "period") row[a] = `2025-0${(i % 9) + 1}-01`;
        else if (a === "category") row[a] = `Category ${i + 1}`;
        else row[a] = valueFor(a, i);
      }
      return row;
    };
    const rows = grouped ? Array.from({ length: 6 }, (_, i) => buildRow(i)) : [buildRow(0)];
    return { success: true, columns: aliases, rows, rowCount: rows.length, truncated: false, executionTimeMs: 1 } satisfies ExecutionResult;
  }) as QueryExecutor;
}

describe("buildDashboard — end-to-end wiring against the real demo schema", () => {
  it("produces a well-formed dashboard without crashing, with no AI call (deterministic mode)", async () => {
    const config = loadConfig({ SUMMARY_MODE: "deterministic" });
    const data = await buildDashboard(getBuiltinContext(), config, { execute: fakeExecutor() });

    expect(data.datasetId).toBe("demo");
    expect(data.tableCount).toBeGreaterThan(0);
    expect(data.kpis.length).toBeGreaterThan(0);
    expect(data.kpis.length).toBeLessThanOrEqual(6);
    expect(data.summary.source).toBe("deterministic");
    expect(data.summary.sentences.length).toBeGreaterThan(0);
    expect(data.suggestedQuestions.length).toBeGreaterThan(0);
    expect(data.relationships.tables.length).toBe(data.tableCount);
    // every KPI must carry real evidence (source tables), never a floating unexplained number
    for (const kpi of data.kpis) expect(kpi.sourceTables.length).toBeGreaterThan(0);
    for (const insight of data.insights) expect(insight.sourceTables.length).toBeGreaterThan(0);
  });

  it("never calls the AI provider when no provider is passed and mode is deterministic", async () => {
    const config = loadConfig({ SUMMARY_MODE: "deterministic" });
    const data = await buildDashboard(getBuiltinContext(), config, { execute: fakeExecutor() });
    expect(data.aiNotice).toBeUndefined();
  });

  it("relationships come straight from the registry's real foreign keys, matching its relationship count", async () => {
    const config = loadConfig({ SUMMARY_MODE: "deterministic" });
    const dataset = getBuiltinContext();
    const data = await buildDashboard(dataset, config, { execute: fakeExecutor() });
    expect(data.relationships.edges.length).toBe(dataset.registry.relationships.length);
  });
});
