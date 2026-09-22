import type pg from "pg";
import { builtinIndex } from "@/lib/metadata/registry";
import type { MetadataRegistry, Relationship } from "@/lib/types";
import { createDatasetContext, DEMO_DATASET_ID, getBuiltinContext, type DatasetContext, type DatasetSourceType } from "./context";
import type { RelationshipSuggestion } from "./suggest-relationships";
import { suggestQuestions } from "./suggestions";
import { quoteIdent } from "./sql-util";

/**
 * Dataset records (nl2sql.datasets) and access control.
 * Visibility: the built-in demo is visible to everyone; an uploaded dataset only to the browser session that uploaded it.
 */

export type DatasetStatus = "processing" | "ready" | "failed" | "deleted";

export interface Dataset {
  id: string;
  name: string;
  sourceType: DatasetSourceType;
  status: DatasetStatus;
  tableCount: number;
  columnCount: number;
  rowCount: number;
  relationshipCount: number;
  createdAt: string;
  isBuiltin: boolean;
  error?: string;
  embeddingStatus?: string;
  descriptionsGeneratedBy?: string;
  /** CSV datasets: suggested relationships still waiting for the user's confirmation. */
  pendingRelationships: number;
}

export class DatasetError extends Error {
  constructor(
    readonly code: "not_found" | "not_ready",
    message: string,
  ) {
    super(message);
    this.name = "DatasetError";
  }
}

interface Row {
  id: string;
  name: string;
  source_type: DatasetSourceType;
  status: DatasetStatus;
  schema_name: string;
  role_name: string | null;
  session_id: string | null;
  table_count: number;
  column_count: number;
  row_count: string | number;
  relationship_count: number;
  error: string | null;
  metadata: MetadataRegistry | null;
  suggested_relationships: RelationshipSuggestion[] | null;
  embedding_status: string | null;
  descriptions_generated_by: string | null;
  created_at: Date;
  updated_at: Date;
}

export async function getDatasetRow(pool: pg.Pool, id: string): Promise<Row | undefined> {
  return (await pool.query("SELECT * FROM nl2sql.datasets WHERE id = $1", [id])).rows[0] as Row | undefined;
}

/** Owner check. The demo (session_id NULL) is public; anything else must belong to the caller's session. */
export function canAccess(row: Row, sessionId: string | undefined): boolean {
  if (row.status === "deleted") return false;
  return row.session_id === null || (sessionId !== undefined && row.session_id === sessionId);
}

let builtinRows: { at: number; n: number } | undefined;
async function builtinRowCount(pool: pg.Pool): Promise<number> {
  if (builtinRows && Date.now() - builtinRows.at < 60_000) return builtinRows.n;
  const names = builtinIndex.tableNames;
  const sql = names.map((t) => `SELECT count(*) AS n FROM ${quoteIdent("shop")}.${quoteIdent(t)}`).join(" UNION ALL ");
  const total = (await pool.query(`SELECT COALESCE(sum(n), 0)::bigint AS total FROM (${sql}) x`)).rows[0].total;
  builtinRows = { at: Date.now(), n: Number(total) };
  return builtinRows.n;
}

async function toDataset(pool: pg.Pool, r: Row): Promise<Dataset> {
  const builtin = r.id === DEMO_DATASET_ID;
  const registry = builtin ? builtinIndex.registry : r.metadata;
  return {
    id: r.id,
    name: r.name,
    sourceType: r.source_type,
    status: r.status,
    tableCount: builtin ? builtinIndex.tableNames.length : r.table_count,
    columnCount: builtin ? builtinIndex.registry.tables.reduce((n, t) => n + t.columns.length, 0) : r.column_count,
    rowCount: builtin ? await builtinRowCount(pool).catch(() => 0) : Number(r.row_count),
    relationshipCount: builtin ? (registry?.relationships.length ?? 0) : r.relationship_count,
    createdAt: new Date(r.created_at).toISOString(),
    isBuiltin: builtin,
    error: r.error ?? undefined,
    embeddingStatus: r.embedding_status ?? undefined,
    descriptionsGeneratedBy: r.descriptions_generated_by ?? undefined,
    pendingRelationships: r.suggested_relationships?.length ?? 0,
  };
}

/** Stale "processing" rows (the serverless function died mid-import) are reported as failed. */
const STALE_PROCESSING_MS = 5 * 60_000;

export async function listDatasets(pool: pg.Pool, sessionId: string | undefined): Promise<Dataset[]> {
  const res = await pool.query(
    `SELECT * FROM nl2sql.datasets
      WHERE status <> 'deleted' AND (session_id IS NULL OR session_id = $1)
      ORDER BY (id = 'demo') DESC, created_at DESC`,
    [sessionId ?? null],
  );
  const out: Dataset[] = [];
  for (const r of res.rows as Row[]) {
    if (r.status === "processing" && Date.now() - new Date(r.created_at).getTime() > STALE_PROCESSING_MS) {
      r.status = "failed";
      r.error = "The import did not finish (the request was interrupted). Nothing was kept — please upload again.";
      await pool.query("UPDATE nl2sql.datasets SET status = 'failed', error = $2, updated_at = now() WHERE id = $1 AND status = 'processing'", [r.id, r.error]);
    }
    out.push(await toDataset(pool, r));
  }
  return out;
}

const contextCache = new Map<string, { updatedAt: number; ctx: DatasetContext }>();

/**
 * Resolve a dataset id to the context the NL2SQL engine runs against. Throws DatasetError when the dataset does not exist,
 * belongs to somebody else, or is not ready — a query can never run against a dataset the caller may not use.
 */
export async function loadDatasetContext(pool: pg.Pool | undefined, id: string, sessionId: string | undefined): Promise<DatasetContext> {
  if (id === DEMO_DATASET_ID) return getBuiltinContext();
  if (!pool) throw new DatasetError("not_found", "Dataset not found.");
  const row = await getDatasetRow(pool, id);
  if (!row || !canAccess(row, sessionId)) throw new DatasetError("not_found", "Dataset not found.");
  if (row.status !== "ready" || !row.metadata) throw new DatasetError("not_ready", row.status === "processing" ? "This dataset is still being processed." : "This dataset is not available (import failed).");
  const stamp = new Date(row.updated_at).getTime();
  const cached = contextCache.get(id);
  if (cached && cached.updatedAt === stamp) return cached.ctx;
  const ctx = createDatasetContext({
    id: row.id,
    name: row.name,
    sourceType: row.source_type,
    schemaName: row.schema_name,
    executionRole: row.role_name ?? undefined,
    registry: row.metadata,
  });
  contextCache.set(id, { updatedAt: stamp, ctx });
  return ctx;
}

export function forgetContext(id: string) {
  contextCache.delete(id);
}

export interface DatasetDetails {
  dataset: Dataset;
  tables: {
    name: string;
    description: string;
    descriptionSource?: string;
    rowCount?: number;
    primaryKey: string[];
    columns: { name: string; type: string; nullable?: boolean; primaryKey: boolean; references?: string; description: string; descriptionSource?: string; sampleValues?: string[] }[];
  }[];
  relationships: Relationship[];
  suggestedRelationships: RelationshipSuggestion[];
  suggestedQuestions: string[];
  warnings: string[];
}

export async function getDatasetDetails(pool: pg.Pool, id: string, sessionId: string | undefined): Promise<DatasetDetails> {
  const row = await getDatasetRow(pool, id);
  if (!row || !canAccess(row, sessionId)) throw new DatasetError("not_found", "Dataset not found.");
  const registry = id === DEMO_DATASET_ID ? builtinIndex.registry : row.metadata;
  const dataset = await toDataset(pool, row);
  if (!registry) return { dataset, tables: [], relationships: [], suggestedRelationships: [], suggestedQuestions: [], warnings: [] };
  return {
    dataset,
    tables: registry.tables.map((t) => ({
      name: t.name,
      description: t.description,
      descriptionSource: t.descriptionSource,
      rowCount: t.rowCount,
      primaryKey: t.primaryKey,
      columns: t.columns.map((c) => ({
        name: c.name,
        type: c.type,
        nullable: c.nullable,
        primaryKey: !!c.primaryKey || t.primaryKey.includes(c.name),
        references: c.references ? `${c.references.table}.${c.references.column}` : undefined,
        description: c.description,
        descriptionSource: c.descriptionSource,
        sampleValues: c.sampleValues,
      })),
    })),
    relationships: registry.relationships,
    suggestedRelationships: row.suggested_relationships ?? [],
    suggestedQuestions: id === DEMO_DATASET_ID ? (getBuiltinContext().suggestedQuestions ?? suggestQuestions(registry)) : suggestQuestions(registry),
    warnings: [],
  };
}
