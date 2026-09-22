import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { pointAtTestDatabase, testDatabaseUrl } from "../helpers/db";
import { loadConfig } from "@/lib/config";
import { closePools, getAdminPool } from "@/lib/database/client";
import { processQuestion } from "@/lib/nl2sql/orchestrator";
import { PgRunStore, getRun, isRateLimited, listHistory, saveFeedback, hashClient } from "@/lib/history/store";
import { countEmbeddings, syncMetadataEmbeddings, toVectorLiteral, vectorSearch } from "@/lib/metadata/embeddings";
import { retrieveMetadata } from "@/lib/nl2sql/metadata-retriever";
import { route } from "@/lib/nl2sql/router";
import { HashEmbedder, hashEmbedding } from "../helpers/hash-embedder";
import { ScriptedProvider, analysisOk, sqlAnswer } from "../helpers/scripted-provider";

pointAtTestDatabase();

const config = loadConfig({ SUMMARY_MODE: "deterministic" });
let pool: pg.Pool;

beforeAll(() => {
  pool = getAdminPool();
});
afterAll(async () => {
  await pool.query("DELETE FROM nl2sql.query_runs");
  await closePools();
});

const CATEGORY_SQL = "SELECT c.name AS category, ROUND(SUM(oi.line_total)::numeric, 2) AS revenue FROM order_items oi JOIN orders o ON o.order_id = oi.order_id JOIN products p ON p.product_id = oi.product_id JOIN product_categories c ON c.category_id = p.category_id WHERE o.status IN ('shipped','delivered') GROUP BY c.category_id, c.name ORDER BY revenue DESC LIMIT 5";

describe("question → routing → sub-schema → SQL → validation → database → result (real database, scripted LLM)", () => {
  it("answers a ranking question end to end and stores the run", async () => {
    const provider = new ScriptedProvider({ "question analysis": [analysisOk()], "SQL generation": [sqlAnswer(CATEGORY_SQL, { explanation: "Revenue by category." })] });
    const res = await processQuestion("What were the top 5 product categories by revenue?", { sessionId: "s-e2e", clientHash: "c-e2e" }, { provider, config, useVectorSearch: false });

    expect(res.success).toBe(true);
    expect(res.status).toBe("success");
    expect(res.rows).toHaveLength(5);
    expect(res.columns).toEqual(["category", "revenue"]);
    expect(res.tablesUsed).toEqual(["order_items", "orders", "product_categories", "products"]);
    expect(res.answer).toContain(String(res.rows[0].category));
    expect(res.executionTimeMs).toBeGreaterThanOrEqual(0);
    expect(res.attempts).toBe(1);
    expect(res.trace.routing?.selectedTables).toContain("product_categories");

    // rows really are descending and come from the database
    const revenues = res.rows.map((r) => r.revenue as number);
    expect([...revenues].sort((a, b) => b - a)).toEqual(revenues);

    // persisted with the full trace but WITHOUT the result rows
    expect(res.runId).toBeTruthy();
    const stored = await getRun(pool, "s-e2e", res.runId!);
    expect(stored.status).toBe("success");
    expect(stored.row_count).toBe(5);
    expect(stored.attempt_count).toBe(1);
    expect(stored.tables_used).toContain("orders");
    expect(stored.trace.routing.selectedTables.length).toBeGreaterThan(0);
    expect(JSON.stringify(stored.trace)).not.toContain(String(res.rows[0].revenue));
  });

  it("self-corrects a failing query against the real database", async () => {
    // valid per the validator (unqualified single-table column check passes for a CTE) but fails in PostgreSQL:
    // ROUND(double precision, int) does not exist → the correction agent is asked to fix it.
    const failing = "SELECT ROUND(AVG(o.total_amount)::float8, 2) AS average_order_value FROM orders o WHERE o.status IN ('shipped','delivered')";
    const fixed = "SELECT ROUND(AVG(o.total_amount)::numeric, 2) AS average_order_value FROM orders o WHERE o.status IN ('shipped','delivered')";
    const provider = new ScriptedProvider({
      "question analysis": [analysisOk({ query_type: "aggregation" })],
      "SQL generation": [sqlAnswer(failing)],
      "SQL correction": [{ diagnosis: "round(double precision, integer) does not exist; cast to numeric", sql: fixed, explanation: "Average order value", tables_used: ["orders"], assumptions: [] }],
    });
    const res = await processQuestion("What was the average order value?", { sessionId: "s-corr" }, { provider, config, useVectorSearch: false });

    expect(res.success).toBe(true);
    expect(res.attempts).toBe(2);
    expect(res.corrections).toHaveLength(1);
    expect(res.corrections[0].failureStage).toBe("execution");
    expect(res.corrections[0].error.code).toBe("42883");
    expect(res.corrections[0].error.message).toContain("round");
    expect(res.corrections[0].outcome).toBe("success");
    expect(typeof res.rows[0].average_order_value).toBe("number");
    // the correction prompt contains the real database error
    expect(provider.callsFor("SQL correction")[0].prompt).toContain("does not exist");
  });

  it("never lets a destructive statement reach the database", async () => {
    const before = (await pool.query("SELECT count(*)::int AS n FROM shop.customers")).rows[0].n;
    const provider = new ScriptedProvider({ "question analysis": [analysisOk()], "SQL generation": [sqlAnswer("DELETE FROM customers")] });
    const res = await processQuestion("Show me the customers", { sessionId: "s-evil" }, { provider, config, useVectorSearch: false });
    expect(res.success).toBe(false);
    expect(res.error?.code).toBe("SQL_REJECTED");
    expect((await pool.query("SELECT count(*)::int AS n FROM shop.customers")).rows[0].n).toBe(before);
  });

  it("returns 'No matching records were found.' when the query matches nothing", async () => {
    const sql = "SELECT c.first_name FROM customers c WHERE c.email = 'nobody@nowhere.invalid'";
    const provider = new ScriptedProvider({ "question analysis": [analysisOk()], "SQL generation": [sqlAnswer(sql)] });
    const res = await processQuestion("Which customers have the email nobody@nowhere.invalid?", { sessionId: "s-empty" }, { provider, config, useVectorSearch: false });
    expect(res.status).toBe("no_results");
    expect(res.answer).toBe("No matching records were found.");
    expect(res.rows).toEqual([]);
  });

  it("truncates huge results at MAX_ROWS", async () => {
    const small = loadConfig({ SUMMARY_MODE: "deterministic", MAX_ROWS: "10" });
    const provider = new ScriptedProvider({ "question analysis": [analysisOk()], "SQL generation": [sqlAnswer("SELECT o.order_id FROM orders o ORDER BY o.order_id")] });
    const res = await processQuestion("List all order ids of orders", { sessionId: "s-cap" }, { provider, config: small, useVectorSearch: false });
    expect(res.rows).toHaveLength(10);
    expect(res.truncated).toBe(true);
    expect(res.answer).toContain("row limit");
  });
});

describe("history, feedback and rate limiting", () => {
  it("lists only the session's own history, newest first", async () => {
    const store = new PgRunStore(pool);
    const mk = (q: string) => ({ success: true, status: "success" as const, answer: "a", keyPoints: [], tablesUsed: [], columnsUsed: [], columns: [], rows: [], rowCount: 1, truncated: false, totalLatencyMs: 5, attempts: 1, corrections: [], trace: { question: q, attempts: [], corrections: [], llmCalls: [], timings: [] } });
    await store.save(mk("first"), { sessionId: "hist-A" }, {});
    await store.save(mk("second"), { sessionId: "hist-A" }, {});
    await store.save(mk("other user"), { sessionId: "hist-B" }, {});
    const a = await listHistory(pool, "hist-A");
    expect(a.map((r) => r.question)).toEqual(["second", "first"]);
    expect((await listHistory(pool, "hist-B")).map((r) => r.question)).toEqual(["other user"]);
    expect(await getRun(pool, "hist-B", (await listHistory(pool, "hist-A"))[0].id)).toBeUndefined();
  });

  it("accepts feedback only from the owning session", async () => {
    const provider = new ScriptedProvider({ "question analysis": [analysisOk()], "SQL generation": [sqlAnswer("SELECT COUNT(*) AS n FROM customers")] });
    const res = await processQuestion("How many customers are there?", { sessionId: "fb-owner" }, { provider, config, useVectorSearch: false });
    expect(await saveFeedback(pool, "someone-else", res.runId!, 1)).toBe(false);
    expect(await saveFeedback(pool, "fb-owner", res.runId!, -1, "wrong")).toBe(true);
    const fb = await pool.query("SELECT rating, comment FROM nl2sql.feedback WHERE run_id = $1", [res.runId]);
    expect(fb.rows).toEqual([{ rating: -1, comment: "wrong" }]);
  });

  it("rate-limits per client hash", async () => {
    const hash = hashClient("203.0.113.9", "salt");
    const store = new PgRunStore(pool);
    const run = { success: true, status: "success" as const, answer: "a", keyPoints: [], tablesUsed: [], columnsUsed: [], columns: [], rows: [], rowCount: 0, truncated: false, totalLatencyMs: 1, attempts: 1, corrections: [], trace: { question: "q", attempts: [], corrections: [], llmCalls: [], timings: [] } };
    expect(await isRateLimited(pool, hash, 3)).toBe(false);
    for (let i = 0; i < 3; i++) await store.save(run, { sessionId: "rl", clientHash: hash }, {});
    expect(await isRateLimited(pool, hash, 3)).toBe(true);
    expect(await isRateLimited(pool, hashClient("198.51.100.1", "salt"), 3)).toBe(false);
  });
});

describe("pgvector retrieval (plumbing verified with a deterministic test embedder)", () => {
  it("syncs embeddings idempotently, searches by cosine similarity, and removes orphans", async () => {
    await pool.query("DELETE FROM nl2sql.metadata_embeddings");
    const embedder = new HashEmbedder();
    const first = await syncMetadataEmbeddings(pool, embedder);
    expect(first.embedded).toBe(first.total);
    expect(await countEmbeddings(pool)).toBe(first.total);

    const again = await syncMetadataEmbeddings(pool, embedder);
    expect(again.embedded).toBe(0);
    expect(again.unchanged).toBe(first.total);

    await pool.query("INSERT INTO nl2sql.metadata_embeddings (item_id, kind, content, content_hash, model, embedding) VALUES ('table:ghost','table','x','x','hash-768',$1::vector)", [toVectorLiteral(hashEmbedding("ghost"))]);
    const cleaned = await syncMetadataEmbeddings(pool, embedder);
    expect(cleaned.removed).toBe(1);

    const hits = await vectorSearch(pool, hashEmbedding("refund reason damaged wrong item refunded amount"), 5, "hash-768");
    expect(hits).toHaveLength(5);
    expect(hits[0].similarity).toBeGreaterThanOrEqual(hits[4].similarity);
    expect(hits.some((h) => h.itemId.includes("refunds"))).toBe(true);
  });

  it("switches retrieval to hybrid when embeddings exist, and falls back to lexical when the embedder fails", async () => {
    const embedder = new HashEmbedder();
    await syncMetadataEmbeddings(pool, embedder);
    const hybrid = await retrieveMetadata("What percentage of orders were refunded?", { vector: { provider: embedder, pool } });
    expect(hybrid.method).toBe("hybrid");
    expect(hybrid.items.some((i) => i.vectorScore !== undefined)).toBe(true);
    expect(route(hybrid.items, hybrid.method).selectedTables).toContain("refunds");

    const broken = new HashEmbedder();
    broken.embed = async () => {
      throw new Error("embedding API down");
    };
    const fallback = await retrieveMetadata("What percentage of orders were refunded?", { vector: { provider: broken, pool } });
    expect(fallback.method).toBe("lexical");
    expect(fallback.vectorUnavailableReason).toContain("embedding API down");
    expect(route(fallback.items, fallback.method).selectedTables).toContain("refunds");

    await pool.query("DELETE FROM nl2sql.metadata_embeddings");
    const empty = await retrieveMetadata("refunds", { vector: { provider: embedder, pool } });
    expect(empty.method).toBe("lexical");
    expect(empty.vectorUnavailableReason).toContain("metadata:embed");
  });

  it("rejects vectors of the wrong dimension at the database level", async () => {
    await expect(pool.query("INSERT INTO nl2sql.metadata_embeddings (item_id, kind, content, content_hash, model, embedding) VALUES ('t','table','x','x','m','[1,2,3]'::vector)")).rejects.toThrow();
  });
});

describe("RLS", () => {
  it("is enabled on every shop and nl2sql table", async () => {
    const res = await pool.query("SELECT tablename FROM pg_tables WHERE schemaname IN ('shop','nl2sql') AND NOT rowsecurity");
    expect(res.rows).toEqual([]);
  });
  it("lets the anon-like read-only role read shop data but nothing in nl2sql", async () => {
    const c = new pg.Client({ connectionString: testDatabaseUrl() });
    await c.connect();
    try {
      await c.query("BEGIN");
      await c.query("SET LOCAL ROLE nl2sql_readonly");
      expect((await c.query("SELECT count(*)::int AS n FROM shop.orders")).rows[0].n).toBeGreaterThan(0);
      await expect(c.query("SELECT * FROM nl2sql.query_runs")).rejects.toThrow(/permission denied/);
    } finally {
      await c.query("ROLLBACK");
      await c.end();
    }
  });
});
