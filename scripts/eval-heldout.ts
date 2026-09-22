/**
 * Held-out evaluation on UPLOADED datasets (+ the built-in demo).
 *
 *   npm run eval:heldout                offline part (no LLM): upload corpus, relationship suggestions, gold validity, routing
 *   npm run eval:heldout -- --live      + the complete pipeline with the configured LLM on all 40 questions
 *   Options: --ids a,b   --delay MS   --note "free text stored in the result file (e.g. provider details)"   --out file.json
 *
 * Path measured end to end:  UPLOAD → IMPORT → INTROSPECTION → METADATA → ROUTING → SUB-SCHEMA → SQL GENERATION → VALIDATION → EXECUTION → RESULT
 * Gold answers exist only in tests/evaluation/heldout/questions.ts (SQL run against the imported data); the engine never sees them.
 * Only numbers produced by an actual run are written. Nothing is cached, replayed or simulated by this script.
 */
import { config as loadEnv } from "dotenv";
import fs from "node:fs";
import path from "node:path";
import { getProvider } from "../src/lib/ai/provider";
import { getConfig } from "../src/lib/config";
import { closePools, getAdminPool } from "../src/lib/database/client";
import { deleteDataset, importDataset } from "../src/lib/datasets/import-service";
import { ImportError, UNSUPPORTED_SQL_MESSAGE, getUploadLimits } from "../src/lib/datasets/limits";
import { processQuestion } from "../src/lib/nl2sql/orchestrator";
import { analyzeWithRules } from "../src/lib/nl2sql/question-analyzer";
import { wilson95 } from "../tests/evaluation/stats";
import { loadHeldoutDatasets, matchGold, routedTables, runGold, removeHeldoutDatasets } from "../tests/evaluation/heldout/harness";
import { HELDOUT, HELDOUT_NEGATIVES, type HeldoutCase } from "../tests/evaluation/heldout/questions";
import { UPLOAD_CORPUS } from "../tests/evaluation/heldout/upload-corpus";

loadEnv({ path: ".env.local" });
loadEnv({ path: ".env" });

const args = process.argv.slice(2);
const flag = (n: string) => args.includes(`--${n}`);
const opt = (n: string) => {
  const i = args.indexOf(`--${n}`);
  return i >= 0 ? args[i + 1] : undefined;
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const SESSION = "eval-heldout";
const CLIENT = "eval-heldout";

const rate = (k: number, n: number) => ({ k, n, ...(wilson95(k, n) ?? { rate: null, low: null, high: null }) });

interface CaseResult {
  id: string;
  dataset: string;
  category: string;
  question: string;
  status: string;
  routingRecall: boolean;
  routedTables: string[];
  expectedTables: string[];
  sqlGenerated: boolean;
  firstAttemptValid: boolean | null;
  executed: boolean;
  resultMatch: boolean | null;
  matchedBy?: string;
  mismatchReason?: string;
  attempts: number;
  naturalCorrections: { failureStage: string; errorCode: string; repairedToCorrect: boolean | null }[];
  latencyMs: number;
  llmCalls: number;
  error?: string;
  sql?: string;
}

async function uploadCorpusMetrics(pool: ReturnType<typeof getAdminPool>) {
  const limits = { ...getUploadLimits(), maxUploadsPerHour: 100000, maxDatasetsPerSession: 100000 };
  const counts = async () => ({
    schemas: (await pool.query("SELECT count(*)::int AS n FROM pg_namespace WHERE nspname LIKE 'ds\\_%'")).rows[0].n as number,
    roles: (await pool.query("SELECT count(*)::int AS n FROM pg_roles WHERE rolname LIKE 'nl2sql\\_ro\\_%'")).rows[0].n as number,
    orders: (await pool.query("SELECT count(*)::int AS n FROM shop.orders")).rows[0].n as number,
    runs: (await pool.query("SELECT count(*)::int AS n FROM nl2sql.query_runs")).rows[0].n as number,
  });
  const out = new Map<string, { total: number; accepted: number; rejected: number; standardMessage: number; leftBehind: number; failures: string[] }>();
  const created: string[] = [];
  for (const c of UPLOAD_CORPUS) {
    const o = out.get(c.kind) ?? { total: 0, accepted: 0, rejected: 0, standardMessage: 0, leftBehind: 0, failures: [] };
    out.set(c.kind, o);
    o.total++;
    const before = await counts();
    try {
      const ds = await importDataset({ name: c.id, files: c.files, generateDescriptions: false }, { pool, sessionId: "eval-upload-corpus", clientHash: "eval-upload-corpus", limits });
      created.push(ds.id);
      o.accepted++;
    } catch (e) {
      o.rejected++;
      if (e instanceof ImportError && e.message === UNSUPPORTED_SQL_MESSAGE) o.standardMessage++;
      const after = await counts();
      if (JSON.stringify(after) !== JSON.stringify(before)) {
        o.leftBehind++;
        o.failures.push(`${c.id}: residue after rejection`);
      }
    }
    const expectAccept = c.kind.startsWith("valid");
    const last = out.get(c.kind)!;
    if (expectAccept && last.rejected > 0 && !last.failures.some((f) => f.startsWith(c.id))) {
      /* recorded below via counts */
    }
  }
  for (const id of created) await deleteDataset(pool, id).catch(() => undefined);
  await pool.query("DELETE FROM nl2sql.datasets WHERE session_id = 'eval-upload-corpus'");
  const of = (k: string) => out.get(k)!;
  return {
    validSql: rate(of("valid_sql").accepted, of("valid_sql").total),
    validCsv: rate(of("valid_csv").accepted, of("valid_csv").total),
    malformedSqlRejected: rate(of("malformed_sql").rejected, of("malformed_sql").total),
    malformedCsvRejected: rate(of("malformed_csv").rejected, of("malformed_csv").total),
    maliciousSqlRejected: rate(of("malicious_sql").rejected, of("malicious_sql").total),
    maliciousWithStandardMessage: rate(of("malicious_sql").standardMessage, of("malicious_sql").total),
    rejectedFilesLeavingResidue: of("malicious_sql").leftBehind + of("malformed_sql").leftBehind + of("malformed_csv").leftBehind,
    corpusSize: UPLOAD_CORPUS.length,
  };
}

async function main() {
  if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is not set.");
  const cfg = getConfig();
  const pool = getAdminPool();
  const live = flag("live");
  const provider = getProvider();
  const provided = cfg.ai.model ? `${provider.name}/${provider.model}` : null;
  if (live && !cfg.ai.model) throw new Error("--live needs an LLM (AI_PROVIDER / AI_MODEL / AI_API_KEY or a keyless AI_BASE_URL).");

  const startedAt = new Date().toISOString();
  const report: Record<string, unknown> = {
    generatedAt: startedAt,
    note: opt("note") ?? null,
    benchmark: { answerable: HELDOUT.length, negative: HELDOUT_NEGATIVES.length, heldOut: true, description: "written before the first run; not used to tune the system" },
    provider: live ? provided : "not used (offline part)",
    config: { analysisMode: cfg.analysisMode ?? null, summaryMode: cfg.summaryMode ?? null, maxSqlAttempts: cfg.limits.maxSqlAttempts ?? null, retrieval: "lexical only (no embedding model configured)" },
  };

  console.log("Uploading the held-out datasets through the real importer …");
  const loaded = await loadHeldoutDatasets(pool, { sessionId: SESSION, clientHash: CLIENT, provider: live ? provider : undefined });
  const datasetIds = [loaded.ids.hr, loaded.ids.sales];
  try {
    report.datasets = {
      hr: { source: "one .sql file (pg_dump style)", ...loaded.hrStats, importMs: loaded.importMs.hr },
      sales: { source: "six .csv files", ...loaded.salesStats, importMs: loaded.importMs.sales },
      demo: { source: "built-in demo (curated metadata)", tables: 20 },
    };
    const s = loaded.relationshipSuggestions;
    report.csvRelationshipSuggestions = {
      expected: s.expected.length,
      suggested: s.suggested.length,
      truePositives: s.correct.length,
      precision: s.suggested.length ? Math.round((1000 * s.correct.length) / s.suggested.length) / 10 : null,
      recall: Math.round((1000 * s.correct.length) / s.expected.length) / 10,
      missed: s.missed,
      unexpected: s.unexpected,
      note: "Suggestions are never trusted automatically: they became foreign keys only after this script 'confirmed' them, like the UI's confirm button.",
    };

    console.log("Upload corpus (valid / malformed / malicious) …");
    report.uploadCorpus = await uploadCorpusMetrics(pool);

    // ── offline: gold validity + routing (lexical, no LLM) ──
    console.log("Gold queries + deterministic routing …");
    const gold = new Map<string, Awaited<ReturnType<typeof runGold>>>();
    const offline: { id: string; goldOk: boolean; routingRecall: boolean; routed: string[]; tables: number; totalTables: number }[] = [];
    for (const c of HELDOUT) {
      const ctx = loaded.contexts[c.dataset];
      const g = await runGold(ctx, c);
      gold.set(c.id, g);
      const r = await routedTables(ctx, c.question);
      offline.push({ id: c.id, goldOk: g.ok, routingRecall: c.expectedTables.every((t) => r.tables.includes(t)), routed: r.tables, tables: r.tables.length, totalTables: ctx.index.tableNames.length });
    }
    report.offline = {
      goldQueriesValidAndExecuted: rate(offline.filter((o) => o.goldOk).length, offline.length),
      routingAllNeededTables_lexicalOnly: rate(offline.filter((o) => o.routingRecall).length, offline.length),
      avgRoutedTables: Math.round((10 * offline.reduce((a, o) => a + o.tables, 0)) / offline.length) / 10,
      avgSchemaTables: Math.round((10 * offline.reduce((a, o) => a + o.totalTables, 0)) / offline.length) / 10,
      routingMisses: offline.filter((o) => !o.routingRecall).map((o) => ({ id: o.id, routed: o.routed, expected: HELDOUT.find((h) => h.id === o.id)!.expectedTables })),
    };

    report.offlineNegatives = {
      note: "Deterministic rules only (no LLM call): what the pipeline decides before any model is involved.",
      perCase: HELDOUT_NEGATIVES.map((n) => ({ id: n.id, kind: n.kind, ruleDecision: analyzeWithRules(n.question, loaded.contexts[n.dataset].lexical, loaded.contexts[n.dataset]).decision })),
    };

    if (live) {
      const only = opt("ids")?.split(",");
      const delay = Number(opt("delay") ?? 0);
      const cases = HELDOUT.filter((c) => !only || only.includes(c.id));
      const datasetIdOf = (d: HeldoutCase["dataset"]) => loaded.ids[d];
      const results: CaseResult[] = [];

      for (const c of cases) {
        process.stdout.write(`  ${c.id.padEnd(9)} `);
        const started = Date.now();
        const res = await processQuestion({ question: c.question, datasetId: datasetIdOf(c.dataset) }, { sessionId: SESSION, clientHash: CLIENT }, { provider, pool, config: cfg });
        const g = gold.get(c.id)!;
        const attempts = res.trace.attempts;
        const sub = res.trace.subSchema?.tables ?? [];
        let resultMatch: boolean | null = null;
        let matchedBy: string | undefined;
        let mismatchReason: string | undefined;
        if (res.success && g.ok) {
          const m = matchGold(g, res.columns, res.rows);
          resultMatch = m.match;
          matchedBy = m.by;
          if (!m.match) mismatchReason = m.reason;
        }
        // NATURAL corrections only: these arise from the model's own failures (no fault is injected in this script)
        const naturalCorrections = res.corrections.map((k) => ({ failureStage: k.failureStage, errorCode: String(k.error.code), repairedToCorrect: res.success ? resultMatch : false }));
        const r: CaseResult = {
          id: c.id,
          dataset: c.dataset,
          category: c.category,
          question: c.question,
          status: res.status,
          routingRecall: c.expectedTables.every((t) => sub.includes(t)),
          routedTables: sub,
          expectedTables: c.expectedTables,
          sqlGenerated: attempts.length > 0,
          firstAttemptValid: attempts.length ? attempts[0].validation.valid : null,
          executed: res.success,
          resultMatch,
          matchedBy,
          mismatchReason,
          attempts: res.attempts,
          naturalCorrections,
          latencyMs: Date.now() - started,
          llmCalls: res.trace.llmCalls.length,
          error: res.error ? `${res.error.code}: ${res.error.message}` : undefined,
          sql: res.sql,
        };
        results.push(r);
        console.log(`${r.status.padEnd(20)} ${r.resultMatch === null ? (r.executed ? "no-gold" : "—") : r.resultMatch ? "match ✓" : "MISMATCH"}  (${r.attempts} attempt${r.attempts === 1 ? "" : "s"}, ${(r.latencyMs / 1000).toFixed(1)}s)`);
        if (delay) await sleep(delay);
      }

      // negatives: nothing may be answered, and nothing may be modified
      const snapshot = async () => ({
        hr: (await pool.query(`SELECT (SELECT count(*) FROM ${loaded.ids.hr}.employees)::int e, (SELECT count(*) FROM ${loaded.ids.hr}.salaries)::int s`)).rows[0],
        sales: (await pool.query(`SELECT (SELECT count(*) FROM ${loaded.ids.sales}.orders)::int o, (SELECT count(*) FROM ${loaded.ids.sales}.customers)::int c`)).rows[0],
        demo: (await pool.query("SELECT (SELECT count(*) FROM shop.customers)::int c, (SELECT count(*) FROM shop.orders)::int o")).rows[0],
        tables: (await pool.query("SELECT count(*)::int n FROM information_schema.tables WHERE table_schema IN ('shop', $1, $2)", [loaded.ids.hr, loaded.ids.sales])).rows[0].n,
      });
      const before = await snapshot();
      const negatives: { id: string; kind: string; question: string; status: string; declined: boolean; refusedByDesign: boolean; errorCode?: string; sql?: string }[] = [];
      for (const n of HELDOUT_NEGATIVES.filter((x) => !only || only.includes(x.id))) {
        process.stdout.write(`  ${n.id.padEnd(9)} `);
        const res = await processQuestion({ question: n.question, datasetId: datasetIdOf(n.dataset) }, { sessionId: SESSION, clientHash: CLIENT }, { provider, pool, config: cfg });
        // declined = no successful answer was produced (refused, asked to clarify, or failed safely)
        const declined = !res.success || res.status === "out_of_scope" || res.status === "needs_clarification";
        // refusedByDesign: the pipeline itself said no (out of scope / clarification). A provider or SQL error also yields no answer, but is a failure, not a refusal.
        const refusedByDesign = res.status === "out_of_scope" || res.status === "needs_clarification";
        negatives.push({ id: n.id, kind: n.kind, question: n.question, status: res.status, declined: declined && res.rows.length === 0, refusedByDesign, errorCode: res.error?.code, sql: res.sql });
        console.log(`${res.status}${declined ? "" : "  ← ANSWERED"}`);
        if (delay) await sleep(delay);
      }
      const after = await snapshot();

      // ── aggregate ──
      const n = results.length;
      const gen = results.filter((r) => r.sqlGenerated);
      const exec = results.filter((r) => r.executed);
      const scored = results.filter((r) => r.resultMatch !== null);
      const by = (key: "category" | "dataset") => {
        const groups: Record<string, CaseResult[]> = {};
        for (const r of results) (groups[r[key]] ??= []).push(r);
        return Object.fromEntries(Object.entries(groups).map(([k, v]) => [k, { cases: v.length, resultCorrect: rate(v.filter((x) => x.resultMatch === true).length, v.length), routing: rate(v.filter((x) => x.routingRecall).length, v.length) }]));
      };
      const withCorrection = results.filter((r) => r.naturalCorrections.length > 0);
      const lat = results.map((r) => r.latencyMs).sort((a, b) => a - b);
      report.live = {
        provider: provided,
        cases: n,
        endToEnd_resultCorrect: rate(results.filter((r) => r.resultMatch === true).length, n),
        routing_allNeededTablesInSubSchema: rate(results.filter((r) => r.routingRecall).length, n),
        avgSubSchemaTables: Math.round((10 * results.reduce((a, r) => a + r.routedTables.length, 0)) / n) / 10,
        sqlGenerated: rate(gen.length, n),
        sqlValid_firstAttempt_ofGenerated: rate(gen.filter((r) => r.firstAttemptValid).length, gen.length),
        executionSuccess_ofAll: rate(exec.length, n),
        executionSuccess_ofGenerated: rate(exec.filter((r) => r.sqlGenerated).length, gen.length),
        resultCorrect_ofExecuted: rate(scored.filter((r) => r.resultMatch).length, scored.length),
        firstAttemptSuccess: rate(results.filter((r) => r.executed && r.attempts === 1).length, n),
        acceptedViaAlternativeGold: results.filter((r) => r.matchedBy === "alternative").map((r) => r.id),
        naturalSelfCorrection: {
          note: "Only failures that occurred naturally (no fault injection). Reported as counts, not as a rate, when small.",
          casesThatNeededCorrection: withCorrection.length,
          repairedToCorrectResult: withCorrection.filter((r) => r.resultMatch === true).length,
          details: withCorrection.map((r) => ({ id: r.id, corrections: r.naturalCorrections, finalStatus: r.status, resultMatch: r.resultMatch })),
        },
        failureBreakdown: {
          declinedAnswerableQuestion: results.filter((r) => r.status === "out_of_scope" || r.status === "needs_clarification").map((r) => `${r.id}:${r.status}`),
          providerErrors: results.filter((r) => r.error?.startsWith("PROVIDER_")).map((r) => `${r.id}:${r.error}`),
          sqlFailures: results.filter((r) => r.status === "error" && !r.error?.startsWith("PROVIDER_")).map((r) => `${r.id}:${r.error}`),
          wrongResult: results.filter((r) => r.resultMatch === false).map((r) => `${r.id}:${r.mismatchReason}`),
        },
        byCategory: by("category"),
        byDataset: by("dataset"),
        negatives: {
          noAnswerProduced: rate(negatives.filter((x) => x.declined).length, negatives.length),
          refusedByDesign: rate(negatives.filter((x) => x.refusedByDesign).length, negatives.length),
          databaseUnchanged: JSON.stringify(before) === JSON.stringify(after),
          before,
          after,
          details: negatives,
        },
        latencyMs: { p50: lat[Math.floor(n / 2)], p95: lat[Math.min(n - 1, Math.floor(n * 0.95))] },
        avgLlmCalls: Math.round((10 * results.reduce((a, r) => a + r.llmCalls, 0)) / n) / 10,
        perCase: results,
      };
      const { perCase, ...summary } = report.live as { perCase: unknown };
      void perCase;
      console.log(JSON.stringify(summary, null, 2));
    }
  } finally {
    await removeHeldoutDatasets(pool, datasetIds);
    await pool.query("DELETE FROM nl2sql.query_runs WHERE session_id = $1", [SESSION]).catch(() => undefined);
    await pool.query("DELETE FROM nl2sql.datasets WHERE session_id = $1", [SESSION]).catch(() => undefined);
  }

  const outDir = path.resolve("tests/evaluation/results");
  fs.mkdirSync(outDir, { recursive: true });
  const out = opt("out") ?? path.join(outDir, live ? "latest-heldout-live.json" : "latest-heldout-offline.json");
  fs.writeFileSync(out, JSON.stringify(report, null, 2));
  if (!live) console.log(JSON.stringify(report, null, 2));
  console.log(`\nWrote ${out}`);
  await closePools();
}

main().catch(async (err) => {
  console.error(err.message ?? err);
  await closePools();
  process.exit(1);
});
