import { createHash } from "node:crypto";
import type pg from "pg";
import type { QueryResponse } from "@/lib/types";

/**
 * Persistence for query runs (history + full agent trace) and user feedback.
 * Only row COUNTS are stored — never the result rows themselves.
 */

export interface RunContext {
  sessionId?: string;
  /** Dataset the question is asked against (defaults to the built-in demo). */
  datasetId?: string;
  clientHash?: string;
}

export interface RunStore {
  save(response: QueryResponse, ctx: RunContext, meta: { provider?: string; model?: string }): Promise<string | undefined>;
}

export class PgRunStore implements RunStore {
  constructor(private readonly pool: pg.Pool) {}

  async save(r: QueryResponse, ctx: RunContext, meta: { provider?: string; model?: string }): Promise<string | undefined> {
    const res = await this.pool.query(
      `INSERT INTO nl2sql.query_runs
         (session_id, client_hash, user_question, generated_sql, tables_used, columns_used, attempt_count, status, error, answer,
          row_count, execution_time_ms, total_latency_ms, provider, model, trace, dataset_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)
       RETURNING id`,
      [
        ctx.sessionId ?? null,
        ctx.clientHash ?? null,
        r.trace.question,
        r.sql ?? null,
        r.tablesUsed,
        r.columnsUsed,
        r.attempts,
        r.status,
        r.error ? `${r.error.code}: ${r.error.message}` : null,
        r.answer,
        r.rowCount,
        r.executionTimeMs ?? null,
        r.totalLatencyMs,
        meta.provider ?? null,
        meta.model ?? null,
        JSON.stringify(r.trace),
        r.dataset?.id ?? ctx.datasetId ?? "demo",
      ],
    );
    return res.rows[0]?.id as string | undefined;
  }
}

export interface HistoryEntry {
  id: string;
  datasetId: string;
  datasetName: string;
  question: string;
  status: string;
  sql: string | null;
  tablesUsed: string[];
  attempts: number;
  rowCount: number | null;
  executionTimeMs: number | null;
  answer: string | null;
  createdAt: string;
}

/**
 * Recent runs of this session. Filtered to ONE dataset by default (history never mixes datasets); pass datasetId "all"
 * to list every dataset — each entry always carries the dataset it ran against.
 */
export async function listHistory(pool: pg.Pool, sessionId: string, limit = 20, options: { datasetId?: string } = {}): Promise<HistoryEntry[]> {
  const all = options.datasetId === "all";
  const params: unknown[] = [sessionId, limit];
  if (!all) params.push(options.datasetId ?? "demo");
  const res = await pool.query(
    `SELECT q.id, q.dataset_id, COALESCE(d.name, q.dataset_id) AS dataset_name, q.user_question, q.status, q.generated_sql, q.tables_used,
            q.attempt_count, q.row_count, q.execution_time_ms, q.answer, q.created_at
       FROM nl2sql.query_runs q LEFT JOIN nl2sql.datasets d ON d.id = q.dataset_id
      WHERE q.session_id = $1 ${all ? "" : "AND q.dataset_id = $3"} ORDER BY q.created_at DESC LIMIT $2`,
    params,
  );
  return res.rows.map((r) => ({
    id: r.id,
    datasetId: r.dataset_id,
    datasetName: r.dataset_name,
    question: r.user_question,
    status: r.status,
    sql: r.generated_sql,
    tablesUsed: r.tables_used ?? [],
    attempts: r.attempt_count,
    rowCount: r.row_count,
    executionTimeMs: r.execution_time_ms,
    answer: r.answer,
    createdAt: new Date(r.created_at).toISOString(),
  }));
}

/** Full stored run (including trace) for one history entry, only if it belongs to the session. */
export async function getRun(pool: pg.Pool, sessionId: string, id: string) {
  const res = await pool.query(`SELECT * FROM nl2sql.query_runs WHERE id = $1 AND session_id = $2`, [id, sessionId]);
  return res.rows[0];
}

export async function saveFeedback(pool: pg.Pool, sessionId: string, runId: string, rating: 1 | -1, comment?: string): Promise<boolean> {
  const res = await pool.query(
    `INSERT INTO nl2sql.feedback (run_id, rating, comment)
       SELECT id, $3, $4 FROM nl2sql.query_runs WHERE id = $1 AND session_id = $2
       RETURNING id`,
    [runId, sessionId, rating, comment?.slice(0, 500) ?? null],
  );
  return (res.rowCount ?? 0) > 0;
}

// ───────────────────────── rate limiting ─────────────────────────
export function hashClient(ip: string, salt: string): string {
  return createHash("sha256").update(`${salt}:${ip}`).digest("hex").slice(0, 32);
}

/** DB-backed limiter (works across serverless instances): count this client's runs in the last minute. */
export async function isRateLimited(pool: pg.Pool, clientHash: string, limitPerMinute: number): Promise<boolean> {
  const res = await pool.query(
    `SELECT count(*)::int AS n FROM nl2sql.query_runs WHERE client_hash = $1 AND created_at > now() - interval '1 minute'`,
    [clientHash],
  );
  return res.rows[0].n >= limitPerMinute;
}
