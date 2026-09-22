import { describe, expect, it } from "vitest";
import { loadConfig } from "@/lib/config";
import { processQuestion, type OrchestratorDeps } from "@/lib/nl2sql/orchestrator";
import type { ExecutionResult, QueryResponse } from "@/lib/types";
import type { RunStore } from "@/lib/history/store";
import { ScriptedProvider, analysisOk, sqlAnswer } from "../helpers/scripted-provider";
import { fixtureContext } from "../helpers/datasets";

/**
 * Control-flow tests for the orchestrator with a scripted LLM and a fake executor.
 * (End-to-end tests against a real database live in tests/integration.)
 */
const config = loadConfig({ SUMMARY_MODE: "deterministic" });
const QUESTION = "What were the top 5 product categories by revenue last month?";
const GOOD_SQL = "SELECT c.name AS category, SUM(oi.line_total) AS revenue FROM order_items oi JOIN orders o ON o.order_id = oi.order_id JOIN products p ON p.product_id = oi.product_id JOIN product_categories c ON c.category_id = p.category_id GROUP BY c.name ORDER BY revenue DESC LIMIT 5";

const okExec = (rows: Record<string, unknown>[] = [{ category: "Computers", revenue: 100 }]): ExecutionResult => ({
  success: true,
  columns: Object.keys(rows[0] ?? { category: 1, revenue: 1 }),
  rows,
  rowCount: rows.length,
  truncated: false,
  executionTimeMs: 3,
});
const dbError = (code: string, category: string, detail: string): ExecutionResult => ({
  success: false,
  executionTimeMs: 2,
  error: { code, category: category as never, message: "friendly", detail },
});

function run(provider: ScriptedProvider, execute: OrchestratorDeps["execute"], question = QUESTION, extra: Partial<OrchestratorDeps> = {}) {
  const saved: QueryResponse[] = [];
  const store: RunStore = { save: async (r) => (saved.push(r), "run-1") };
  return processQuestion(question, {}, { provider, config, execute, store, useVectorSearch: false, ...extra }).then((res) => ({ res, saved }));
}

describe("orchestrator", () => {
  it("runs the full pipeline and records the trace", async () => {
    const provider = new ScriptedProvider({ "question analysis": [analysisOk()], "SQL generation": [sqlAnswer(GOOD_SQL)] });
    const { res, saved } = await run(provider, async () => okExec());
    expect(res.success).toBe(true);
    expect(res.status).toBe("success");
    expect(res.attempts).toBe(1);
    expect(res.rows).toHaveLength(1);
    expect(res.tablesUsed).toEqual(["order_items", "orders", "product_categories", "products"]);
    expect(res.trace.routing?.selectedTables.length).toBeGreaterThan(0);
    expect(res.trace.subSchema?.tables).toContain("product_categories");
    expect(res.trace.llmCalls.map((c) => c.purpose)).toEqual(["analysis", "sql_generation"]);
    expect(res.runId).toBe("run-1");
    expect(saved).toHaveLength(1);
  });

  it("passes only the sub-schema (not all 20 tables) to the SQL generator", async () => {
    const provider = new ScriptedProvider({ "question analysis": [analysisOk()], "SQL generation": [sqlAnswer(GOOD_SQL)] });
    await run(provider, async () => okExec());
    const prompt = provider.callsFor("SQL generation")[0].prompt;
    expect(prompt).toContain("TABLE product_categories");
    expect(prompt).not.toContain("TABLE payments");
    expect(prompt).not.toContain("TABLE employees");
  });

  it("does not call the model for out-of-scope questions", async () => {
    const provider = new ScriptedProvider({});
    const { res } = await run(provider, async () => okExec(), "What's the weather today?");
    expect(res.status).toBe("out_of_scope");
    expect(res.answer).toContain("outside the available database domain");
    expect(provider.calls).toHaveLength(0);
  });

  it("returns a clarification for ambiguous questions without generating SQL", async () => {
    const provider = new ScriptedProvider({});
    const { res } = await run(provider, async () => okExec(), "What were the sales?");
    expect(res.status).toBe("needs_clarification");
    expect(res.clarification?.options.length).toBeGreaterThan(0);
    expect(provider.callsFor("SQL generation")).toHaveLength(0);
  });

  it("handles empty questions", async () => {
    const provider = new ScriptedProvider({});
    const { res, saved } = await run(provider, async () => okExec(), "   ");
    expect(res.error?.code).toBe("EMPTY_QUESTION");
    expect(saved).toHaveLength(0);
  });

  it("returns 'No matching records were found.' for empty results", async () => {
    const provider = new ScriptedProvider({ "question analysis": [analysisOk()], "SQL generation": [sqlAnswer(GOOD_SQL)] });
    const { res } = await run(provider, async () => ({ success: true, columns: ["category", "revenue"], rows: [], rowCount: 0, truncated: false, executionTimeMs: 1 }));
    expect(res.status).toBe("no_results");
    expect(res.answer).toBe("No matching records were found.");
  });

  describe("self-correction", () => {
    it("diagnoses a database error, corrects the SQL, and succeeds on attempt 2", async () => {
      const provider = new ScriptedProvider({
        "question analysis": [analysisOk()],
        "SQL generation": [sqlAnswer(GOOD_SQL.replace("c.name", "c.category_name"))],
        "SQL correction": [{ diagnosis: "c.category_name does not exist; the column is name", sql: GOOD_SQL, explanation: "uses c.name", tables_used: [], assumptions: [] }],
      });
      const seen: string[] = [];
      const { res } = await run(provider, async ({ sql }) => (seen.push(sql), okExec()));
      expect(res.success).toBe(true);
      expect(res.attempts).toBe(2);
      expect(res.corrections).toHaveLength(1);
      expect(res.corrections[0]).toMatchObject({ attempt: 1, failureStage: "validation", outcome: "success" });
      expect(res.corrections[0].diagnosis).toContain("category_name");
      expect(res.corrections[0].correctedSql).toBe(GOOD_SQL);
      // the first (hallucinated column) attempt is caught by the validator, so the DB was only hit once
      expect(seen).toHaveLength(1);
      expect(provider.callsFor("SQL correction")[0].prompt).toContain("category_name");
    });

    it("corrects a database execution error (not just validator errors)", async () => {
      const provider = new ScriptedProvider({
        "question analysis": [analysisOk()],
        "SQL generation": [sqlAnswer(GOOD_SQL)],
        "SQL correction": [{ diagnosis: "division by zero in the ratio", sql: GOOD_SQL.replace("LIMIT 5", "LIMIT 6"), explanation: "", tables_used: [], assumptions: [] }],
      });
      let n = 0;
      const { res } = await run(provider, async () => (++n === 1 ? dbError("22012", "data_exception", "division by zero") : okExec()));
      expect(res.success).toBe(true);
      expect(res.attempts).toBe(2);
      expect(res.corrections[0].failureStage).toBe("execution");
      expect(res.corrections[0].error.message).toContain("division by zero");
      expect(res.trace.attempts).toHaveLength(2);
      expect(res.trace.attempts[0].execution?.success).toBe(false);
      expect(res.trace.attempts[1].execution?.success).toBe(true);
    });

    it("stops after the maximum number of attempts (never loops forever)", async () => {
      let corrections = 0;
      const provider = new ScriptedProvider({
        "question analysis": [analysisOk()],
        "SQL generation": [sqlAnswer(GOOD_SQL)],
        "SQL correction": () => ({ diagnosis: "still wrong", sql: `${GOOD_SQL} /*x*/`.replace("/*x*/", `OFFSET ${++corrections}`), explanation: "", tables_used: [], assumptions: [] }),
      });
      const { res } = await run(provider, async () => dbError("42601", "syntax", 'syntax error at or near "OFFSET"'));
      expect(res.success).toBe(false);
      expect(res.error?.code).toBe("SQL_EXECUTION_FAILED");
      expect(res.attempts).toBe(3);
      expect(provider.callsFor("SQL correction")).toHaveLength(2);
      expect(res.corrections.at(-1)?.outcome).toBe("not_run");
    });

    it("respects MAX_SQL_ATTEMPTS", async () => {
      const provider = new ScriptedProvider({
        "question analysis": [analysisOk()],
        "SQL generation": [sqlAnswer(GOOD_SQL)],
        "SQL correction": [{ diagnosis: "d", sql: `${GOOD_SQL} OFFSET 1`, explanation: "", tables_used: [], assumptions: [] }],
      });
      const one = loadConfig({ MAX_SQL_ATTEMPTS: "1", SUMMARY_MODE: "deterministic" });
      const { res } = await run(provider, async () => dbError("42601", "syntax", "x"), QUESTION, { config: one });
      expect(res.attempts).toBe(1);
      expect(provider.callsFor("SQL correction")).toHaveLength(0);
    });

    it("stops if the correction agent repeats a query that already failed", async () => {
      const provider = new ScriptedProvider({
        "question analysis": [analysisOk()],
        "SQL generation": [sqlAnswer(GOOD_SQL)],
        "SQL correction": [{ diagnosis: "d", sql: GOOD_SQL, explanation: "", tables_used: [], assumptions: [] }],
      });
      const { res } = await run(provider, async () => dbError("42601", "syntax", "x"));
      expect(res.success).toBe(false);
      expect(res.attempts).toBe(1);
      expect(res.error?.message).toContain("already failed");
    });

    it("does not retry when the database is unreachable", async () => {
      const provider = new ScriptedProvider({ "question analysis": [analysisOk()], "SQL generation": [sqlAnswer(GOOD_SQL)] });
      const { res } = await run(provider, async () => dbError("ECONNREFUSED", "connection", "x"));
      expect(res.error?.code).toBe("DATABASE_UNAVAILABLE");
      expect(provider.callsFor("SQL correction")).toHaveLength(0);
    });
  });

  describe("SQL safety inside the pipeline", () => {
    it("blocks model-generated destructive SQL outright and never executes it", async () => {
      const provider = new ScriptedProvider({ "question analysis": [analysisOk()], "SQL generation": [sqlAnswer("DELETE FROM customers")] });
      let executed = 0;
      const { res } = await run(provider, async () => (executed++, okExec()));
      expect(res.success).toBe(false);
      expect(res.error?.code).toBe("SQL_REJECTED");
      expect(executed).toBe(0);
      expect(provider.callsFor("SQL correction")).toHaveLength(0);
    });

    it("sends recoverable validator failures (hallucinated table) to the correction agent", async () => {
      const provider = new ScriptedProvider({
        "question analysis": [analysisOk()],
        "SQL generation": [sqlAnswer("SELECT * FROM sales_summary")],
        "SQL correction": [{ diagnosis: "sales_summary does not exist", sql: GOOD_SQL, explanation: "", tables_used: [], assumptions: [] }],
      });
      const { res } = await run(provider, async () => okExec());
      expect(res.success).toBe(true);
      expect(res.corrections[0].error.code).toBe("UNKNOWN_TABLE");
    });

    it("rejects stacked statements without executing", async () => {
      const provider = new ScriptedProvider({ "question analysis": [analysisOk()], "SQL generation": [sqlAnswer("SELECT 1 FROM orders; DROP TABLE orders")] });
      let executed = 0;
      const { res } = await run(provider, async () => (executed++, okExec()));
      expect(res.success).toBe(false);
      expect(executed).toBe(0);
    });
  });

  describe("provider failures", () => {
    it("surfaces provider errors with a user-facing message", async () => {
      const { ProviderError } = await import("@/lib/ai/provider");
      const provider = new ScriptedProvider({ "question analysis": [new ProviderError("PROVIDER_RATE_LIMIT", "The AI provider rate limit was reached. Wait a moment and try again.")] });
      const { res } = await run(provider, async () => okExec());
      expect(res.error?.code).toBe("PROVIDER_RATE_LIMIT");
      expect(res.answer).toContain("rate limit");
      expect(res.trace.llmCalls).toEqual([expect.objectContaining({ purpose: "analysis", ok: false })]);
    });

    it("does not fail the request when only the summary step fails", async () => {
      const llmConfig = loadConfig({ SUMMARY_MODE: "llm" });
      const provider = new ScriptedProvider({ "question analysis": [analysisOk()], "SQL generation": [sqlAnswer(GOOD_SQL)], "result summary": [new Error("boom")] });
      const { res } = await run(provider, async () => okExec(), QUESTION, { config: llmConfig });
      expect(res.success).toBe(true);
      expect(res.rows).toHaveLength(1);
    });

    it("keeps working when the history store fails", async () => {
      const provider = new ScriptedProvider({ "question analysis": [analysisOk()], "SQL generation": [sqlAnswer(GOOD_SQL)] });
      const store: RunStore = { save: async () => { throw new Error("db down"); } };
      const res = await processQuestion(QUESTION, {}, { provider, config, execute: async () => okExec(), store, useVectorSearch: false });
      expect(res.success).toBe(true);
      expect(res.runId).toBeUndefined();
    });
  });
});

describe("privacy: result rows are not sent to the model for uploaded datasets", () => {
  const llmConfig = loadConfig({ SUMMARY_MODE: "llm" });
  const SECRET = "Zzyzx-Confidential-Value";
  const summary = { summary: "Done.", key_points: [] };

  it("an uploaded dataset gets a locally built summary: the model is never called with the rows", async () => {
    const hr = fixtureContext("ds_1111111111", "Company HR");
    const provider = new ScriptedProvider({ "question analysis": [analysisOk()], "SQL generation": [sqlAnswer("SELECT d.name FROM departments d")], "result summary": [summary] });
    const { res } = await run(provider, async () => okExec([{ name: SECRET }]), "Which departments exist?", { dataset: hr, config: llmConfig });
    expect(res.success).toBe(true);
    expect(res.answer + JSON.stringify(res.rows)).toContain(SECRET); // the user still sees their own data ...
    expect(provider.callsFor("result summary")).toHaveLength(0); // ... but the model was not asked to summarise it
    expect(provider.calls.every((c) => !(c.prompt + (c.system ?? "")).includes(SECRET))).toBe(true);
    expect(res.trace.llmCalls.map((c) => c.purpose)).not.toContain("result_formatting");
  });

  it("the built-in synthetic demo still uses the model for its summary (unchanged behaviour)", async () => {
    const provider = new ScriptedProvider({ "question analysis": [analysisOk()], "SQL generation": [sqlAnswer(GOOD_SQL)], "result summary": [summary] });
    await run(provider, async () => okExec([{ category: "Computers", revenue: 100 }]), QUESTION, { config: llmConfig });
    expect(provider.callsFor("result summary")).toHaveLength(1);
  });
});
