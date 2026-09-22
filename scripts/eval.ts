/**
 * NL2SQL evaluation harness. Runs against the REAL system — nothing is mocked or simulated.
 *
 *   npm run eval                 offline metrics (no LLM): routing accuracy, unsafe-SQL rejection, gold-query validity,
 *                                deterministic scope/ambiguity handling
 *   npm run eval -- --live       + the full pipeline with the configured LLM on every benchmark question:
 *                                execution success, execution accuracy vs gold results, correction success, safety
 *   npm run eval -- --faults     fault-injection test of the self-correction agent: known-good gold SQL is deliberately
 *                                broken (wrong column / table / function / type / syntax) and the REAL correction agent
 *                                must repair it using the REAL validator/database error; the repaired result is compared
 *                                with the gold result. (The first failure is injected — say so when quoting the number.)
 *   Options: --limit N   --ids a,b,c   --delay MS   --out path.json
 *
 * Results are written to tests/evaluation/results/. Only numbers produced by an actual run are reported.
 */
import { config as loadEnv } from "dotenv";
import fs from "node:fs";
import path from "node:path";
import { getConfig } from "../src/lib/config";
import { closePools, getAdminPool } from "../src/lib/database/client";
import { executeQuery } from "../src/lib/database/executor";
import { toValidatedSql, validateSql } from "../src/lib/database/validator";
import { getProvider } from "../src/lib/ai/provider";
import { retrieveMetadata, getLexicalIndex } from "../src/lib/nl2sql/metadata-retriever";
import { newState, processQuestion, stageBuildSubSchema, stageExecuteWithCorrection } from "../src/lib/nl2sql/orchestrator";
import { analyzeWithRules } from "../src/lib/nl2sql/question-analyzer";
import { route } from "../src/lib/nl2sql/router";
import { buildSubSchema } from "../src/lib/nl2sql/sub-schema-builder";
import { ADVERSARIAL_QUESTIONS, BENCHMARK, NEGATIVE_CASES } from "../tests/evaluation/benchmark";
import { compareResults, shapeOk } from "../tests/evaluation/compare";
import { UNSAFE_SQL } from "../tests/evaluation/unsafe-sql";

loadEnv({ path: ".env.local" });
loadEnv({ path: ".env" });

const args = process.argv.slice(2);
const flag = (name: string) => args.includes(`--${name}`);
const opt = (name: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};
const pct = (n: number, d: number) => (d === 0 ? null : Math.round((1000 * n) / d) / 10);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function offlineMetrics() {
  // 1. routing (lexical, no LLM)
  const routing = { cases: 0, allTablesFound: 0, precisionSum: 0, subSchemaTables: 0, metricHits: 0, metricCases: 0, misses: [] as string[] };
  for (const c of BENCHMARK) {
    const ret = await retrieveMetadata(c.question);
    const r = route(ret.items, ret.method);
    const sub = buildSubSchema(r);
    const got = new Set(sub.tables.map((t) => t.name));
    routing.cases++;
    routing.subSchemaTables += got.size;
    const found = c.expectedTables.filter((t) => got.has(t));
    if (found.length === c.expectedTables.length) routing.allTablesFound++;
    else routing.misses.push(`${c.id}: missing ${c.expectedTables.filter((t) => !got.has(t)).join(", ")}`);
    routing.precisionSum += found.length / Math.max(1, got.size);
    if (c.expectedMetrics?.length) {
      routing.metricCases++;
      if (c.expectedMetrics.every((m) => r.matchedMetrics.includes(m))) routing.metricHits++;
    }
  }

  // 2. unsafe SQL rejection
  let rejected = 0;
  const notRejected: string[] = [];
  for (const u of UNSAFE_SQL) {
    if (!(await validateSql(u.sql)).valid) rejected++;
    else notRejected.push(u.name);
  }

  // 3. gold queries: validate + execute
  let goldOk = 0;
  const goldFail: string[] = [];
  for (const c of BENCHMARK) {
    const v = await validateSql(c.referenceSql);
    if (!v.valid) {
      goldFail.push(`${c.id}: validator`);
      continue;
    }
    const e = await executeQuery({ sql: toValidatedSql(v) });
    if (e.success && shapeOk(c.shape, e.columns, e.rows).match) goldOk++;
    else goldFail.push(`${c.id}: ${e.success ? "shape" : e.error.code}`);
  }

  // 4. deterministic scope / ambiguity handling
  let negOk = 0;
  const negFail: string[] = [];
  for (const n of NEGATIVE_CASES) {
    const d = analyzeWithRules(n.question, getLexicalIndex()).decision;
    const expected = n.kind === "ambiguous" ? "needs_clarification" : "out_of_scope";
    if (d === expected) negOk++;
    else negFail.push(`${n.id}: got ${d}`);
  }

  return {
    routing: {
      cases: routing.cases,
      tableRecallAllFound: pct(routing.allTablesFound, routing.cases),
      avgPrecision: Math.round((1000 * routing.precisionSum) / routing.cases) / 1000,
      avgSubSchemaTables: Math.round((10 * routing.subSchemaTables) / routing.cases) / 10,
      totalTables: 20,
      metricRecognition: pct(routing.metricHits, routing.metricCases),
      misses: routing.misses,
    },
    unsafeSqlRejection: { total: UNSAFE_SQL.length, rejected, rate: pct(rejected, UNSAFE_SQL.length), notRejected },
    goldQueries: { total: BENCHMARK.length, valid: goldOk, rate: pct(goldOk, BENCHMARK.length), failures: goldFail },
    deterministicScopeAndAmbiguity: { total: NEGATIVE_CASES.length, correct: negOk, rate: pct(negOk, NEGATIVE_CASES.length), failures: negFail },
  };
}

interface LiveCaseResult {
  id: string;
  question: string;
  status: string;
  success: boolean;
  attempts: number;
  corrections: number;
  correctionSucceeded: boolean;
  executed: boolean;
  resultMatch: boolean | null;
  shapeMatch: boolean | null;
  reason: string;
  routingRecall: boolean;
  latencyMs: number;
  llmCalls: number;
  error?: string;
  sql?: string;
}

async function liveMetrics() {
  const provider = getProvider();
  const cfg = getConfig();
  if (!cfg.ai.model) throw new Error("--live needs AI_PROVIDER / AI_MODEL / AI_API_KEY (or a keyless AI_BASE_URL) to be configured.");
  const pool = getAdminPool();
  const delay = Number(opt("delay") ?? 0);
  const ids = opt("ids")?.split(",");
  const limit = Number(opt("limit") ?? BENCHMARK.length);
  const cases = BENCHMARK.filter((c) => !ids || ids.includes(c.id)).slice(0, limit);

  const results: LiveCaseResult[] = [];
  for (const c of cases) {
    process.stdout.write(`  ${c.id} … `);
    const started = Date.now();
    const res = await processQuestion(c.question, { sessionId: "eval", clientHash: "eval" }, { provider, pool, config: cfg });
    const gold = await validateSql(c.referenceSql).then((v) => executeQuery({ sql: toValidatedSql(v) }));
    let resultMatch: boolean | null = null;
    let shapeMatch: boolean | null = null;
    let reason = res.error?.message ?? res.status;
    if (res.success && gold.success) {
      if (c.compare === "result") {
        const cmp = compareResults(gold.columns, gold.rows, res.columns, res.rows);
        resultMatch = cmp.match;
        reason = cmp.reason;
      }
      const sh = shapeOk(c.shape, res.columns, res.rows);
      shapeMatch = sh.match;
      if (c.compare === "shape") reason = sh.reason;
    }
    const sel = new Set(res.trace.subSchema?.tables ?? []);
    const last = res.corrections[res.corrections.length - 1];
    const r: LiveCaseResult = {
      id: c.id,
      question: c.question,
      status: res.status,
      success: res.success,
      attempts: res.attempts,
      corrections: res.corrections.filter((x) => x.correctedSql).length,
      correctionSucceeded: res.success && res.corrections.some((x) => x.correctedSql),
      executed: res.success,
      resultMatch,
      shapeMatch,
      reason,
      routingRecall: c.expectedTables.every((t) => sel.has(t)),
      latencyMs: Date.now() - started,
      llmCalls: res.trace.llmCalls.length,
      error: res.error ? `${res.error.code}: ${res.error.message}` : last && !res.success ? last.error.message : undefined,
      sql: res.sql,
    };
    results.push(r);
    console.log(`${r.success ? "ok" : "FAIL"} (${r.attempts} attempt${r.attempts === 1 ? "" : "s"}, ${r.latencyMs} ms) ${r.resultMatch === null ? (r.shapeMatch ? "shape✓" : "") : r.resultMatch ? "match✓" : "MISMATCH"}`);
    if (delay) await sleep(delay);
  }

  // negatives: must not produce SQL
  const negatives: { id: string; kind: string; status: string; ok: boolean }[] = [];
  for (const n of NEGATIVE_CASES) {
    const res = await processQuestion(n.question, { sessionId: "eval", clientHash: "eval" }, { provider, pool, config: cfg });
    const expected = n.kind === "ambiguous" ? "needs_clarification" : "out_of_scope";
    negatives.push({ id: n.id, kind: n.kind, status: res.status, ok: res.status === expected && !res.sql });
    if (delay) await sleep(delay);
  }

  // adversarial prompts: the database must be unchanged and nothing destructive may execute
  const before = (await pool.query("SELECT (SELECT count(*) FROM shop.customers)::int c, (SELECT count(*) FROM shop.products)::int p, (SELECT count(*) FROM shop.orders)::int o")).rows[0];
  const adversarial: { question: string; status: string; sql?: string }[] = [];
  for (const q of ADVERSARIAL_QUESTIONS) {
    const res = await processQuestion(q, { sessionId: "eval", clientHash: "eval" }, { provider, pool, config: cfg });
    adversarial.push({ question: q, status: res.status, sql: res.sql });
    if (delay) await sleep(delay);
  }
  const after = (await pool.query("SELECT (SELECT count(*) FROM shop.customers)::int c, (SELECT count(*) FROM shop.products)::int p, (SELECT count(*) FROM shop.orders)::int o")).rows[0];
  const tablesIntact = (await pool.query("SELECT count(*)::int n FROM information_schema.tables WHERE table_schema='shop'")).rows[0].n === 20;

  const n = results.length;
  const needing = results.filter((r) => r.corrections > 0);
  const resultCases = results.filter((r) => r.resultMatch !== null);
  const shapeCases = results.filter((r) => r.resultMatch === null && r.shapeMatch !== null);
  const latencies = results.map((r) => r.latencyMs).sort((a, b) => a - b);

  return {
    provider: `${provider.name}/${provider.model}`,
    cases: n,
    pipelineSuccessRate: pct(results.filter((r) => r.success).length, n),
    failureBreakdown: {
      providerErrors: results.filter((r) => r.error?.startsWith("PROVIDER_")).length,
      wronglyDeclinedOutOfScope: results.filter((r) => r.status === "out_of_scope").length,
      wronglyAskedClarification: results.filter((r) => r.status === "needs_clarification").length,
      sqlFailures: results.filter((r) => r.status === "error" && !r.error?.startsWith("PROVIDER_")).length,
      wrongResult: results.filter((r) => r.resultMatch === false || r.shapeMatch === false).length,
    },
    firstAttemptSuccessRate: pct(results.filter((r) => r.success && r.attempts === 1).length, n),
    casesNeedingCorrection: needing.length,
    correctionSuccessRate: pct(needing.filter((r) => r.correctionSucceeded).length, needing.length),
    executionAccuracy: { cases: resultCases.length, matched: resultCases.filter((r) => r.resultMatch).length, rate: pct(resultCases.filter((r) => r.resultMatch).length, resultCases.length) },
    shapeAccuracy: { cases: shapeCases.length, matched: shapeCases.filter((r) => r.shapeMatch).length, rate: pct(shapeCases.filter((r) => r.shapeMatch).length, shapeCases.length) },
    routingRecallInPipeline: pct(results.filter((r) => r.routingRecall).length, n),
    latencyMs: { p50: latencies[Math.floor(n / 2)], p95: latencies[Math.min(n - 1, Math.floor(n * 0.95))] },
    avgLlmCalls: Math.round((10 * results.reduce((s, r) => s + r.llmCalls, 0)) / n) / 10,
    negativeHandling: { total: negatives.length, correct: negatives.filter((x) => x.ok).length, details: negatives },
    adversarial: { total: adversarial.length, databaseUnchanged: JSON.stringify(before) === JSON.stringify(after) && tablesIntact, details: adversarial, before, after },
    perCase: results,
  };
}

// ───────────────────────── fault injection for the correction agent ─────────────────────────
interface Fault {
  name: string;
  expectedFailure: string;
  apply: (sql: string) => string;
}

const FAULTS: Fault[] = [
  {
    name: "hallucinated column",
    expectedFailure: "validator UNKNOWN_COLUMN",
    apply: (sql) => sql.replace(/\b(o|p|c|oi|r|s|sh|wi|e|a)\.(status|name|city|reason|carrier|quantity_on_hand|total_amount|line_total|order_date|rating)\b/, "$1.$2_value"),
  },
  {
    name: "hallucinated table",
    expectedFailure: "validator UNKNOWN_TABLE",
    apply: (sql) => sql.replace(/\bFROM (\w+)/, "FROM $1_summary"),
  },
  {
    name: "forbidden function",
    expectedFailure: "validator FORBIDDEN_FUNCTION",
    apply: (sql) => sql.replace(/\bROUND\(/, "ROUND_HALF_EVEN("),
  },
  {
    name: "type error (ROUND on float8)",
    expectedFailure: "database 42883",
    apply: (sql) => sql.replace("::numeric, 2)", "::float8, 2)"),
  },
  {
    name: "missing GROUP BY",
    expectedFailure: "database 42803",
    apply: (sql) => sql.replace(/\s+GROUP BY [^)]*?(?= ORDER BY| HAVING| LIMIT|$)/i, ""),
  },
  {
    name: "syntax error",
    expectedFailure: "database 42601 / parse error",
    apply: (sql) => sql.replace(" WHERE ", " WHERE AND "),
  },
];

async function faultMetrics() {
  const provider = getProvider();
  const cfg = getConfig();
  const dry = flag("dry"); // --dry: only show how each injected fault fails (no LLM needed)
  if (!cfg.ai.model && !dry) throw new Error("--faults needs an LLM configured (AI_PROVIDER / AI_MODEL / AI_API_KEY or AI_BASE_URL).");
  const pool = getAdminPool();
  const limit = Number(opt("limit") ?? 12);
  const delay = Number(opt("delay") ?? 0);
  const deps = { provider, config: cfg, pool, useVectorSearch: false };

  const ids = opt("ids")?.split(",");
  const onlyFault = opt("fault"); // --fault "float8": run only fault types whose name contains this text
  const runs: { case: string; fault: string; injected: string; firstError: string; repaired: boolean; matches: boolean | null; attempts: number; diagnosis?: string; failure?: string; latencyMs: number }[] = [];
  let i = 0;
  for (const c of BENCHMARK) {
    if (runs.length >= limit) break;
    if (ids && !ids.includes(c.id)) continue;
    // rotate through fault types, skipping a fault that does not change the SQL
    for (let k = 0; k < FAULTS.length; k++) {
      const fault = FAULTS[(i + k) % FAULTS.length];
      if (onlyFault && !fault.name.includes(onlyFault)) continue;
      const faulty = fault.apply(c.referenceSql);
      if (faulty === c.referenceSql) continue;
      i = (i + k + 1) % FAULTS.length;
      process.stdout.write(`  ${c.id} / ${fault.name} … `);
      if (dry) {
        const v = await validateSql(faulty);
        if (!v.valid) console.log(`validator ${v.issues[0].code}`);
        else {
          const e = await executeQuery({ sql: toValidatedSql(v) });
          console.log(e.success ? "DID NOT FAIL" : `database ${e.error.code}`);
        }
        runs.push({ case: c.id, fault: fault.name, injected: faulty, firstError: "dry", repaired: false, matches: null, attempts: 0, latencyMs: 0 });
        break;
      }
      const started = Date.now();
      const state = newState(c.question);
      state.trace.provider = provider.name;
      state.trace.model = provider.model;
      const ret = await retrieveMetadata(c.question);
      state.routing = route(ret.items, ret.method);
      stageBuildSubSchema(state);
      state.currentSql = faulty;
      let repaired = false;
      let matches: boolean | null = null;
      let failure: string | undefined;
      try {
        await stageExecuteWithCorrection(state, deps as never);
        repaired = state.execution?.success === true;
      } catch (err) {
        repaired = false;
        failure = (err as Error).message.slice(0, 200);
      }
      if (repaired && state.execution?.success) {
        const gold = await validateSql(c.referenceSql).then((v) => executeQuery({ sql: toValidatedSql(v) }));
        if (gold.success) matches = c.compare === "result" ? compareResults(gold.columns, gold.rows, state.execution.columns, state.execution.rows).match : shapeOk(c.shape, state.execution.columns, state.execution.rows).match;
      }
      const first = state.correctionAttempts[0];
      runs.push({ case: c.id, fault: fault.name, injected: faulty, firstError: first ? `${first.failureStage}:${first.error.code}` : "none (fault did not fail)", repaired, matches, attempts: state.attempts, diagnosis: first?.diagnosis, failure, latencyMs: Date.now() - started });
      console.log(`${repaired ? "repaired" : `NOT repaired (${failure ?? "?"})`} in ${state.attempts} attempt(s), ${matches === null ? "" : matches ? "result ✓" : "result ✗"} (${Date.now() - started} ms)`);
      if (delay) await sleep(delay);
      break;
    }
  }
  const failedFirst = runs.filter((r) => !r.firstError.startsWith("none"));
  return {
    provider: `${provider.name}/${provider.model}`,
    note: "The first failure in each case is deliberately injected into known-good gold SQL; the repair is done by the real correction agent against the real validator/database error.",
    injected: runs.length,
    actuallyFailedFirstAttempt: failedFirst.length,
    repaired: failedFirst.filter((r) => r.repaired).length,
    repairedAndCorrect: failedFirst.filter((r) => r.repaired && r.matches).length,
    repairRate: pct(failedFirst.filter((r) => r.repaired).length, failedFirst.length),
    correctRepairRate: pct(failedFirst.filter((r) => r.repaired && r.matches).length, failedFirst.length),
    byFault: Object.fromEntries(FAULTS.map((f) => [f.name, { total: failedFirst.filter((r) => r.fault === f.name).length, repairedAndCorrect: failedFirst.filter((r) => r.fault === f.name && r.repaired && r.matches).length }])),
    runs,
  };
}

async function main() {
  if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is not set.");
  const outDir = path.resolve("tests/evaluation/results");
  fs.mkdirSync(outDir, { recursive: true });
  const report: Record<string, unknown> = { generatedAt: new Date().toISOString(), benchmarkQuestions: BENCHMARK.length };

  console.log("Offline metrics (no LLM)…");
  report.offline = await offlineMetrics();
  console.log(JSON.stringify(report.offline, null, 2));

  if (flag("live")) {
    console.log("\nLive pipeline evaluation…");
    report.live = await liveMetrics();
    const { perCase, ...summary } = report.live as { perCase: unknown };
    void perCase;
    console.log(JSON.stringify(summary, null, 2));
  }

  if (flag("faults")) {
    console.log("\nSelf-correction fault-injection evaluation…");
    report.faultInjection = await faultMetrics();
    const { runs, ...summary } = report.faultInjection as { runs: unknown };
    void runs;
    console.log(JSON.stringify(summary, null, 2));
  }

  const out = opt("out") ?? path.join(outDir, flag("faults") ? "latest-faults.json" : flag("live") ? "latest-live.json" : "latest-offline.json");
  fs.writeFileSync(out, JSON.stringify(report, null, 2));
  console.log(`\nWrote ${out}`);
  await closePools();
}

main().catch(async (err) => {
  console.error(err.message ?? err);
  await closePools();
  process.exit(1);
});
