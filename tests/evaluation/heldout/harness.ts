import type pg from "pg";
import { executeQuery } from "@/lib/database/executor";
import { toValidatedSql, validateSql } from "@/lib/database/validator";
import { DEMO_DATASET_ID, getBuiltinContext, type DatasetContext } from "@/lib/datasets/context";
import { confirmRelationships, deleteDataset, importDataset } from "@/lib/datasets/import-service";
import { getUploadLimits, type UploadLimits } from "@/lib/datasets/limits";
import { getDatasetDetails, loadDatasetContext } from "@/lib/datasets/store";
import { retrieveMetadata } from "@/lib/nl2sql/metadata-retriever";
import { route } from "@/lib/nl2sql/router";
import { buildSubSchema } from "@/lib/nl2sql/sub-schema-builder";
import type { AIProvider } from "@/lib/ai/provider";
import type { ExecutionResult } from "@/lib/types";
import { compareResults } from "../compare";
import { generateHr, generateSales, hrSql, salesCsvFiles, SALES_EXPECTED_RELATIONSHIPS } from "./data";
import type { HeldoutCase, HeldoutDataset } from "./questions";

export interface LoadedHeldoutDatasets {
  ids: { hr: string; sales: string; demo: string };
  contexts: Record<HeldoutDataset, DatasetContext>;
  importMs: { hr: number; sales: number };
  /** Scoring of the CSV importer's relationship SUGGESTIONS against what a careful human would declare. */
  relationshipSuggestions: { expected: string[]; suggested: string[]; correct: string[]; missed: string[]; unexpected: string[]; confirmed: number };
  hrStats: { tables: number; columns: number; rows: number; relationships: number };
  salesStats: { tables: number; columns: number; rows: number; relationships: number };
}

const rel = (r: { fromTable: string; fromColumn: string; toTable: string; toColumn: string }) => `${r.fromTable}.${r.fromColumn}→${r.toTable}.${r.toColumn}`;

/** Upload → import → introspection → metadata for both datasets, exactly as the UI does it (CSV relationships are confirmed like the user's "confirm all" click). */
export async function loadHeldoutDatasets(
  pool: pg.Pool,
  opts: { sessionId: string; clientHash: string; provider?: AIProvider; limits?: UploadLimits; generateDescriptions?: boolean },
): Promise<LoadedHeldoutDatasets> {
  const limits = opts.limits ?? { ...getUploadLimits(), maxUploadsPerHour: 1000, maxDatasetsPerSession: 50 };
  const deps = { pool, sessionId: opts.sessionId, clientHash: opts.clientHash, provider: opts.provider, limits };
  const generateDescriptions = opts.generateDescriptions ?? false;

  let t = Date.now();
  const hr = await importDataset({ name: "Held-out HR", files: [{ name: "hr.sql", text: hrSql(generateHr()) }], generateDescriptions }, deps);
  const hrMs = Date.now() - t;

  t = Date.now();
  const sales = await importDataset({ name: "Held-out Sales", files: salesCsvFiles(generateSales()), generateDescriptions }, deps);
  const salesMs = Date.now() - t;

  const before = await getDatasetDetails(pool, sales.id, opts.sessionId);
  const suggested = before.suggestedRelationships.map(rel);
  await confirmRelationships(pool, sales.id, before.suggestedRelationships, false, { provider: opts.provider, limits });
  const expected = SALES_EXPECTED_RELATIONSHIPS;

  const hrDetails = await getDatasetDetails(pool, hr.id, opts.sessionId);
  const salesDetails = await getDatasetDetails(pool, sales.id, opts.sessionId);
  const stat = (d: typeof hrDetails) => ({ tables: d.dataset.tableCount, columns: d.dataset.columnCount, rows: d.dataset.rowCount, relationships: d.relationships.length });

  return {
    ids: { hr: hr.id, sales: sales.id, demo: DEMO_DATASET_ID },
    contexts: {
      hr: await loadDatasetContext(pool, hr.id, opts.sessionId),
      sales: await loadDatasetContext(pool, sales.id, opts.sessionId),
      demo: getBuiltinContext(),
    },
    importMs: { hr: hrMs, sales: salesMs },
    relationshipSuggestions: {
      expected,
      suggested,
      correct: expected.filter((e) => suggested.includes(e)),
      missed: expected.filter((e) => !suggested.includes(e)),
      unexpected: suggested.filter((s) => !expected.includes(s)),
      confirmed: before.suggestedRelationships.length,
    },
    hrStats: stat(hrDetails),
    salesStats: stat(salesDetails),
  };
}

export async function removeHeldoutDatasets(pool: pg.Pool, ids: string[]) {
  for (const id of ids) await deleteDataset(pool, id).catch(() => undefined);
}

/** Validate and execute SQL as the dataset's own read-only role (the same path generated SQL takes). */
export async function runAsDataset(ctx: DatasetContext, sql: string): Promise<ExecutionResult> {
  const v = await validateSql(sql, ctx);
  if (!v.valid) return { success: false, executionTimeMs: 0, error: { code: "VALIDATION_FAILED", category: "permission", message: v.issues.map((i) => i.message).join(" "), detail: "" } };
  return executeQuery({ sql: toValidatedSql(v), dataset: ctx });
}

/** The tables the router would put in the sub-schema for a question (lexical retrieval; no LLM, no embeddings). */
export async function routedTables(ctx: DatasetContext, question: string): Promise<{ tables: string[]; method: string }> {
  const ret = await retrieveMetadata(question, { dataset: ctx });
  const routing = route(ret.items, ret.method, ret.vectorUnavailableReason, ctx);
  const sub = buildSubSchema(routing, undefined, ctx);
  return { tables: sub.tables.map((x) => x.name), method: ret.method };
}

export interface GoldRun {
  ok: boolean;
  columns: string[];
  rows: Record<string, unknown>[];
  alternatives: { columns: string[]; rows: Record<string, unknown>[] }[];
  error?: string;
}

export async function runGold(ctx: DatasetContext, c: HeldoutCase): Promise<GoldRun> {
  const main = await runAsDataset(ctx, c.goldSql);
  if (!main.success) return { ok: false, columns: [], rows: [], alternatives: [], error: `${main.error.code}: ${main.error.message}` };
  const alternatives: GoldRun["alternatives"] = [];
  for (const alt of c.altGoldSql ?? []) {
    const r = await runAsDataset(ctx, alt);
    if (!r.success) return { ok: false, columns: [], rows: [], alternatives: [], error: `alternative gold failed: ${r.error.message}` };
    alternatives.push({ columns: r.columns, rows: r.rows });
  }
  return { ok: true, columns: main.columns, rows: main.rows, alternatives };
}

/** Result equality against the gold answer or any accepted alternative representation. */
export function matchGold(gold: GoldRun, columns: string[], rows: Record<string, unknown>[]): { match: boolean; by?: "gold" | "alternative"; reason: string } {
  const primary = compareResults(gold.columns, gold.rows, columns, rows);
  if (primary.match) return { match: true, by: "gold", reason: primary.reason };
  for (const alt of gold.alternatives) {
    const r = compareResults(alt.columns, alt.rows, columns, rows);
    if (r.match) return { match: true, by: "alternative", reason: r.reason };
  }
  return { match: false, reason: primary.reason };
}
