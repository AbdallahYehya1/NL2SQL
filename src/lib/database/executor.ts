import type pg from "pg";
import { getConfig } from "@/lib/config";
import { getBuiltinContext, type DatasetContext } from "@/lib/datasets/context";
import { assertSafeIdent, quoteIdent } from "@/lib/datasets/sql-util";
import type { ExecutionResult, ValidatedSql } from "@/lib/types";
import { getExecutionPool } from "./client";
import { classifyDbError } from "./errors";
import { toValidatedSql, validateSql } from "./validator";

export interface ExecuteQueryOptions {
  /** SQL that passed validateSql() — enforced by the branded type. */
  sql: ValidatedSql;
  /** The dataset to run against. Its schema and read-only role are the ONLY things the query can reach. Default: demo. */
  dataset?: DatasetContext;
  maxRows?: number;
  timeoutMs?: number;
}

/**
 * Run a validated SELECT under defence-in-depth restrictions:
 *   - the dataset's own read-only role (login role, or SET LOCAL ROLE inside the transaction): it has privileges on
 *     THIS dataset's schema only — not on other datasets, not on the application schema
 *   - READ ONLY transaction, always rolled back
 *   - statement_timeout / lock_timeout / idle_in_transaction_session_timeout
 *   - search_path pinned to the dataset's schema
 *   - results fetched through a cursor so at most maxRows+1 rows ever leave the database
 */
export async function executeQuery(options: ExecuteQueryOptions): Promise<ExecutionResult> {
  // Belt and braces: the executor re-validates (against the same dataset) so it can never run anything the validator
  // would reject, even if a caller forged the ValidatedSql brand.
  const dataset = options.dataset ?? getBuiltinContext();
  const recheck = await validateSql(options.sql, dataset);
  if (!recheck.valid) {
    return {
      success: false,
      executionTimeMs: 0,
      error: { code: "VALIDATION_FAILED", category: "permission", message: "The query was rejected before execution.", detail: recheck.issues.map((i) => i.message).join(" ") },
    };
  }
  return runInSandbox({ ...options, dataset, sql: toValidatedSql(recheck) });
}

/**
 * Executes SQL inside the sandboxed transaction WITHOUT re-validating it. Internal: application code must call
 * executeQuery(). It is exported only so the integration tests can prove that the database itself (read-only
 * role + READ ONLY transaction) refuses writes and cross-dataset reads even if validation were bypassed.
 */
export async function runInSandbox(options: ExecuteQueryOptions): Promise<ExecutionResult> {
  const cfg = getConfig();
  const dataset = options.dataset ?? getBuiltinContext();
  const maxRows = options.maxRows ?? cfg.limits.maxRows;
  const timeoutMs = Math.floor(options.timeoutMs ?? cfg.limits.queryTimeoutMs);
  const started = Date.now();
  const elapsed = () => Date.now() - started;

  let client: pg.PoolClient | undefined;
  try {
    const schema = quoteIdent(assertSafeIdent(dataset.schemaName, "schema name"));
    const role = assertSafeIdent(dataset.executionRole ?? cfg.executionRole, "role name");
    const { pool, loggedInAsReadonly } = getExecutionPool();
    client = await pool.connect();
    await client.query("BEGIN READ ONLY");
    await client.query(`SET LOCAL statement_timeout = ${timeoutMs}`);
    await client.query(`SET LOCAL lock_timeout = 2000`);
    await client.query(`SET LOCAL idle_in_transaction_session_timeout = ${timeoutMs + 5000}`);
    await client.query(`SET LOCAL search_path = ${schema}`);
    // When the connection already logs in as the default read-only role (demo dataset) nothing more is needed; every other
    // combination switches to the dataset's own role, which only has privileges on that dataset.
    if (!(loggedInAsReadonly && role === cfg.executionRole)) await client.query(`SET LOCAL ROLE ${quoteIdent(role)}`);

    await client.query(`DECLARE nl2sql_cursor NO SCROLL CURSOR FOR ${options.sql}`);
    const res = await client.query(`FETCH FORWARD ${maxRows + 1} FROM nl2sql_cursor`);

    const truncated = res.rows.length > maxRows;
    const rows = truncated ? res.rows.slice(0, maxRows) : res.rows;
    const columns = res.fields.map((f) => f.name);
    await client.query("ROLLBACK");
    return { success: true, columns, rows, rowCount: rows.length, truncated, executionTimeMs: elapsed() };
  } catch (err) {
    if (client) await client.query("ROLLBACK").catch(() => undefined);
    return { success: false, error: classifyDbError(err), executionTimeMs: elapsed() };
  } finally {
    client?.release();
  }
}
