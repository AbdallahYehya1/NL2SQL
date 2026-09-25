import type { AppConfig } from "@/lib/config";
import { executeQuery } from "@/lib/database/executor";
import { toValidatedSql, validateSql } from "@/lib/database/validator";
import type { DatasetContext } from "@/lib/datasets/context";
import type { ExecutionResult } from "@/lib/types";

/** Same shape as OrchestratorDeps.execute — lets tests inject a fake executor instead of hitting a real database. */
export type QueryExecutor = typeof executeQuery;

/**
 * Runs one app-generated aggregation query through the SAME validateSql()/executeQuery() pipeline every LLM-generated
 * query goes through — no security shortcut for the dashboard. Never throws: a query that fails to validate (a bug
 * in our own SQL-building) or fails to execute returns undefined, so the caller can skip that one section rather
 * than take down the whole dashboard (see engine.ts's warning collection).
 */
export async function runDashboardQuery(sql: string, dataset: DatasetContext, config: AppConfig, execute: QueryExecutor = executeQuery): Promise<Extract<ExecutionResult, { success: true }> | undefined> {
  const validation = await validateSql(sql, dataset);
  if (!validation.valid) return undefined;
  const result = await execute({ sql: toValidatedSql(validation), dataset, maxRows: config.limits.maxRows, timeoutMs: config.limits.queryTimeoutMs });
  return result.success ? result : undefined;
}
