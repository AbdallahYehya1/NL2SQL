import { randomBytes } from "node:crypto";
import type pg from "pg";
import type { AIProvider } from "@/lib/ai/provider";
import { deleteDatasetEmbeddings, syncMetadataEmbeddings } from "@/lib/metadata/embeddings";
import type { MetadataRegistry } from "@/lib/types";
import { createDatasetContext } from "./context";
import { pgTypeFor, planCsvImport, type CsvImportPlan } from "./csv-import";
import { describeSchemaWithLlm } from "./describe";
import { introspectSchema, type IntrospectedSchema } from "./introspect";
import { getUploadLimits, ImportError, type UploadLimits } from "./limits";
import { buildRegistryFromIntrospection, type LlmDescriptions } from "./metadata-builder";
import { assertSafeIdent, quoteIdent } from "./sql-util";
import { planSqlImport, type SqlImportPlan } from "./sql-import";
import { forgetContext, getDatasetRow, listDatasets, type Dataset } from "./store";
import { suggestRelationships, type RelationshipSuggestion } from "./suggest-relationships";

/**
 * Dataset import: uploaded files → an isolated PostgreSQL schema + a generated metadata registry.
 *
 * Isolation and safety, in order:
 *  1. the upload is fully parsed and validated (allow-list) BEFORE anything is executed;
 *  2. it is executed in ONE transaction, on a brand-new schema `ds_<hex>` that is pinned as the search_path;
 *  3. a dedicated NOLOGIN role `nl2sql_ro_<hex>` is created with USAGE + SELECT on that schema only — this is the role
 *     generated queries run as, so it cannot read any other dataset, `shop`, or the application schema `nl2sql`;
 *  4. on any failure the transaction rolls back (nothing is left behind) and the dataset is marked failed.
 * Uploaded content is never logged. The optional import-time LLM descriptions receive structure only (no rows, no sample values);
 * at question time the model sees the question and bounded schema information, never result rows of an uploaded dataset.
 */

export type ImportStep = "parse" | "tables" | "columns" | "load" | "relationships" | "metadata" | "embeddings";
export interface ProgressEvent {
  step: ImportStep;
  status: "running" | "done" | "skipped";
  detail?: string;
}

export interface UploadedFile {
  name: string;
  text: string;
}

export interface ImportRequest {
  name: string;
  files: UploadedFile[];
  /** Ask the LLM to write descriptions (sends table/column names + types only). */
  generateDescriptions: boolean;
}

export interface ImportDeps {
  pool: pg.Pool;
  sessionId: string;
  clientHash: string;
  provider?: AIProvider;
  limits?: UploadLimits;
  onProgress?: (e: ProgressEvent) => void;
}

const hex = (bytes: number) => randomBytes(bytes).toString("hex");
const qs = (schema: string, table: string) => `${quoteIdent(schema)}.${quoteIdent(table)}`;

// ───────────────────────── entry point ─────────────────────────
export async function importDataset(req: ImportRequest, deps: ImportDeps): Promise<Dataset> {
  const limits = deps.limits ?? getUploadLimits();
  const emit = (step: ImportStep, status: ProgressEvent["status"], detail?: string) => deps.onProgress?.({ step, status, detail });
  const name = req.name.replace(/\s+/g, " ").trim().slice(0, limits.maxNameLength) || "Untitled dataset";

  await purgeExpiredDatasets(deps.pool, limits).catch(() => undefined);
  await checkQuotas(deps, limits);

  const kind = decideSourceType(req.files, limits);

  // ── 1. register the dataset (status: processing). Every failure below marks it failed with the reason. ──
  const id = `ds_${hex(5)}`;
  const role = `nl2sql_ro_${id.slice(3)}`;
  await deps.pool.query(
    `INSERT INTO nl2sql.datasets (id, name, source_type, status, schema_name, role_name, session_id, client_hash) VALUES ($1,$2,$3,'processing',$1,$4,$5,$6)`,
    [id, name, kind, role, deps.sessionId, deps.clientHash],
  );

  try {
    // ── 2. parse + validate EVERYTHING before touching the isolated schema ──
    emit("parse", "running");
    let plan: { kind: "sql"; sql: SqlImportPlan } | { kind: "csv"; csv: CsvImportPlan };
    if (kind === "sql") plan = { kind, sql: await planSqlImport(req.files[0].text, limits) };
    else plan = { kind, csv: planCsvImport(req.files, limits) };
    const stats = plan.kind === "sql" ? plan.sql.stats : plan.csv.stats;
    const tableCount = plan.kind === "sql" ? plan.sql.stats.tables.length : plan.csv.stats.tables;
    emit("parse", "done", plan.kind === "sql" ? `${plan.sql.statements.length} statements` : `${plan.csv.tables.length} CSV file(s)`);
    emit("tables", "done", `${tableCount} table${tableCount === 1 ? "" : "s"}`);
    emit("columns", "done", `${stats.columns} column${stats.columns === 1 ? "" : "s"}`);

    // ── 3. load into the isolated schema (one transaction) ──
    emit("load", "running", `${stats.rows.toLocaleString("en-US")} rows`);
    await loadIntoIsolatedSchema(deps.pool, id, role, plan, limits);
    emit("load", "done");

    // ── 4. read the REAL structure back from the catalogs ──
    emit("relationships", "running");
    const schema = await introspectSchema(deps.pool, id, limits);
    const suggestions: RelationshipSuggestion[] = plan.kind === "csv" ? await suggestRelationships(deps.pool, id, schema) : [];
    const fkCount = schema.tables.reduce((n, t) => n + t.foreignKeys.reduce((m, f) => m + f.columns.length, 0), 0);
    emit("relationships", "done", plan.kind === "sql" ? `${fkCount} foreign key${fkCount === 1 ? "" : "s"} found in the SQL` : `${suggestions.length} possible relationship${suggestions.length === 1 ? "" : "s"} to review`);

    // ── 5. metadata registry ──
    emit("metadata", "running");
    let llm: LlmDescriptions | undefined;
    let describedBy: string | undefined;
    if (req.generateDescriptions && deps.provider) {
      try {
        llm = await describeSchemaWithLlm(deps.provider, name, schema);
        describedBy = "llm";
      } catch {
        llm = undefined; // descriptions are optional; the deterministic ones are used
      }
    }
    const registry = buildRegistryFromIntrospection(schema, { llm });
    emit("metadata", "done", describedBy ? "descriptions marked as AI-generated" : "descriptions from the database structure");

    // ── 6. optional embeddings ──
    const embeddingStatus = await embed(deps, id, name, registry, limits, emit);

    const columnCount = schema.tables.reduce((n, t) => n + t.columns.length, 0);
    const rowCount = schema.tables.reduce((n, t) => n + t.rowCount, 0);
    await deps.pool.query(
      `UPDATE nl2sql.datasets SET status = 'ready', metadata = $2, table_count = $3, column_count = $4, row_count = $5, relationship_count = $6,
              suggested_relationships = $7, embedding_status = $8, descriptions_generated_by = $9, error = NULL, updated_at = now() WHERE id = $1`,
      [id, JSON.stringify(registry), schema.tables.length, columnCount, rowCount, registry.relationships.length, suggestions.length ? JSON.stringify(suggestions) : null, embeddingStatus, describedBy ?? null],
    );
    const row = (await listDatasets(deps.pool, deps.sessionId)).find((d) => d.id === id);
    if (!row) throw new Error("Dataset vanished after import.");
    return row;
  } catch (err) {
    // never leave a half-imported dataset behind
    await dropDatasetObjects(deps.pool, id, role).catch(() => undefined);
    await deleteDatasetEmbeddings(deps.pool, id).catch(() => undefined);
    const message = friendlyError(err);
    // full diagnostics stay server-side; the user only sees the friendly message stored below
    // (only the SQLSTATE and the message text before any ':' — PostgreSQL appends the offending VALUE after it, and uploaded content must not reach the logs)
    if (!(err instanceof ImportError)) console.error("[nl2sql] dataset import failed:", (err as { code?: string })?.code ?? "no-sqlstate", String((err as Error)?.message ?? err).split(":")[0].slice(0, 120));
    await deps.pool.query("UPDATE nl2sql.datasets SET status = 'failed', error = $2, metadata = NULL, updated_at = now() WHERE id = $1", [id, message]).catch(() => undefined);
    throw err instanceof ImportError ? err : new ImportError(message);
  }
}

// ───────────────────────── validation helpers ─────────────────────────
function decideSourceType(files: UploadedFile[], limits: UploadLimits): "sql" | "csv" {
  if (files.length === 0) throw new ImportError("Choose at least one .sql or .csv file.");
  if (files.length > limits.maxFiles) throw new ImportError(`Too many files (${files.length}; max ${limits.maxFiles}).`);
  const ext = (f: UploadedFile) => f.name.toLowerCase().split(".").pop();
  const sql = files.filter((f) => ext(f) === "sql");
  const csv = files.filter((f) => ext(f) === "csv");
  if (sql.length + csv.length !== files.length) throw new ImportError("Unsupported file type. Upload a .sql file or one or more .csv files.");
  if (sql.length && csv.length) throw new ImportError("Upload either one .sql file or CSV files — not both in the same dataset.");
  if (sql.length > 1) throw new ImportError("Upload a single .sql file per dataset.");
  return sql.length ? "sql" : "csv";
}

async function checkQuotas(deps: ImportDeps, limits: UploadLimits) {
  const recent = (await deps.pool.query(`SELECT count(*)::int AS n FROM nl2sql.datasets WHERE client_hash = $1 AND created_at > now() - interval '1 hour'`, [deps.clientHash])).rows[0].n;
  if (recent >= limits.maxUploadsPerHour) throw new ImportError(`Upload limit reached (${limits.maxUploadsPerHour} per hour). Please try again later.`, [], 429);
  const mine = (await deps.pool.query(`SELECT count(*)::int AS n FROM nl2sql.datasets WHERE session_id = $1 AND status IN ('ready','processing')`, [deps.sessionId])).rows[0].n;
  if (mine >= limits.maxDatasetsPerSession) throw new ImportError(`You already have ${mine} datasets (max ${limits.maxDatasetsPerSession}). Delete one to add another.`, [], 409);
}

function friendlyError(err: unknown): string {
  if (err instanceof ImportError) return err.message + (err.details.length ? ` — ${err.details.slice(0, 3).join("; ")}` : "");
  const e = err as { code?: string; message?: string };
  if (e?.code === "57014") return "Import took too long and was cancelled. Try a smaller dataset.";
  if (typeof e?.code === "string" && /^(22|23|42)/.test(e.code)) return `The database rejected the data: ${String(e.message).slice(0, 200)}`;
  return "The dataset could not be imported.";
}

// ───────────────────────── isolated load ─────────────────────────
type Plan = { kind: "sql"; sql: SqlImportPlan } | { kind: "csv"; csv: CsvImportPlan };

async function loadIntoIsolatedSchema(pool: pg.Pool, schema: string, role: string, plan: Plan, limits: UploadLimits) {
  assertSafeIdent(schema, "schema name");
  assertSafeIdent(role, "role name");
  const client = await pool.connect();
  try {
    // REPEATABLE READ: the tripwire below compares snapshots, so concurrent imports by other users cannot trigger it.
    await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ");
    await client.query(`SET LOCAL statement_timeout = ${limits.importTimeoutMs}`);
    await client.query("SET LOCAL lock_timeout = 5000");
    const relationsBefore = await relationsOutside(client, schema);
    await client.query(`CREATE SCHEMA ${quoteIdent(schema)}`);
    // Unqualified names in the upload resolve ONLY to the new schema (pg_catalog is always implicitly searched first).
    await client.query(`SET LOCAL search_path = ${quoteIdent(schema)}`);

    if (plan.kind === "sql") {
      await runSqlPlan(client, plan.sql);
      await applyComments(client, plan.sql.comments);
    }
    else await runCsvPlan(client, schema, plan.csv);

    // read-only role + Row Level Security, scoped to this schema
    await client.query(`CREATE ROLE ${quoteIdent(role)} NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT`);
    await client.query(`GRANT USAGE ON SCHEMA ${quoteIdent(schema)} TO ${quoteIdent(role)}`);
    await client.query(`GRANT SELECT ON ALL TABLES IN SCHEMA ${quoteIdent(schema)} TO ${quoteIdent(role)}`);
    const tables = (await client.query(`SELECT tablename FROM pg_tables WHERE schemaname = $1`, [schema])).rows.map((r) => r.tablename as string);
    for (const t of tables) {
      await client.query(`ALTER TABLE ${qs(schema, t)} ENABLE ROW LEVEL SECURITY`);
      await client.query(`CREATE POLICY readonly_select ON ${qs(schema, t)} FOR SELECT TO ${quoteIdent(role)} USING (true)`);
    }
    // let the app's connecting user (and the shared read-only login, if used) SET ROLE to it; harmless if not permitted
    await client.query(
      `DO $$ BEGIN EXECUTE format('GRANT %I TO %I', '${role}', current_user); EXCEPTION WHEN OTHERS THEN RAISE NOTICE 'grant to current_user skipped: %', SQLERRM; END $$`,
    );
    await client.query(
      `DO $$ BEGIN EXECUTE format('GRANT %I TO nl2sql_readonly', '${role}'); EXCEPTION WHEN OTHERS THEN RAISE NOTICE 'grant to nl2sql_readonly skipped: %', SQLERRM; END $$`,
    );

    // tripwire: nothing created by this transaction may live outside the dataset schema
    if ((await relationsOutside(client, schema)) !== relationsBefore) throw new ImportError("The import created objects outside its own schema and was cancelled.");

    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}

/** Number of relations (tables, indexes, sequences, …) living outside `schema` — a tripwire for the import transaction. */
async function relationsOutside(client: pg.PoolClient, schema: string): Promise<number> {
  const res = await client.query(
    `SELECT count(*)::int AS n FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname <> $1 AND n.nspname NOT LIKE 'pg_%' AND n.nspname <> 'information_schema'`,
    [schema],
  );
  return res.rows[0].n as number;
}

/** Execute the pre-validated statements in batches; on failure pinpoint the offending statement for a useful message. */
async function runSqlPlan(client: pg.PoolClient, plan: SqlImportPlan) {
  const BATCH_BYTES = 200_000;
  const BATCH_STATEMENTS = 300;
  let batch: typeof plan.statements = [];
  let bytes = 0;

  const flush = async () => {
    if (!batch.length) return;
    await client.query("SAVEPOINT import_batch");
    try {
      await client.query(batch.map((s) => s.text).join("\n;\n"));
      await client.query("RELEASE SAVEPOINT import_batch");
    } catch (batchErr) {
      // the import time budget ran out: not a problem with one statement — let friendlyError() report it
      if ((batchErr as { code?: string }).code === "57014") throw batchErr;
      // find the failing statement: roll back the batch and replay it one by one
      await client.query("ROLLBACK TO SAVEPOINT import_batch");
      for (const s of batch) {
        try {
          await client.query("SAVEPOINT import_one");
          await client.query(s.text);
          await client.query("RELEASE SAVEPOINT import_one");
        } catch (e) {
          if ((e as { code?: string }).code === "57014") throw e;
          throw new ImportError(`Statement at line ${s.line} failed: ${(e as Error).message.slice(0, 240)}`);
        }
      }
      throw batchErr;
    }
    batch = [];
    bytes = 0;
  };

  for (const s of plan.statements) {
    if (s.kind !== "insert") {
      // structure statements run on their own so order and error location stay exact; INSERTs are batched
      await flush();
      batch = [s];
      await flush();
      continue;
    }
    batch.push(s);
    bytes += s.text.length;
    if (bytes >= BATCH_BYTES || batch.length >= BATCH_STATEMENTS) await flush();
  }
  await flush();
}

/**
 * COMMENT ON statements from the upload are not executed as written; instead the captured texts are re-applied with
 * identifiers quoted by us and the text as an escaped literal (standard_conforming_strings is on). A comment on something
 * that does not exist is skipped. The comments then flow into the metadata as descriptions (source "database").
 */
async function applyComments(client: pg.PoolClient, comments: SqlImportPlan["comments"]) {
  await client.query("SET LOCAL standard_conforming_strings = on");
  for (const c of comments) {
    const text = c.text.replace(/'/g, "''").slice(0, 500);
    const target = c.column ? `COLUMN ${quoteIdent(c.table)}.${quoteIdent(c.column)}` : `TABLE ${quoteIdent(c.table)}`;
    await client.query("SAVEPOINT import_comment");
    try {
      await client.query(`COMMENT ON ${target} IS '${text}'`);
      await client.query("RELEASE SAVEPOINT import_comment");
    } catch {
      await client.query("ROLLBACK TO SAVEPOINT import_comment");
    }
  }
}

const CAST: Record<string, string> = { integer: "integer", bigint: "bigint", numeric: "numeric", boolean: "boolean", date: "date", timestamp: "timestamp", timestamptz: "timestamptz", text: "text" };

async function runCsvPlan(client: pg.PoolClient, schema: string, plan: CsvImportPlan) {
  for (const t of plan.tables) {
    const cols = t.columns.map((c) => `${quoteIdent(c.name)} ${pgTypeFor(c.type)}`).join(", ");
    await client.query(`CREATE TABLE ${qs(schema, t.name)} (${cols})`);
    if (!t.rows.length) continue;
    const perChunk = Math.max(1, Math.floor(30_000 / t.columns.length));
    const colList = t.columns.map((c) => quoteIdent(c.name)).join(", ");
    for (let i = 0; i < t.rows.length; i += perChunk) {
      const chunk = t.rows.slice(i, i + perChunk);
      const params: (string | null)[] = [];
      const tuples = chunk.map((row) => `(${row.map((v, j) => {
        const type = t.columns[j].type;
        params.push(v === null ? null : type === "boolean" ? String(["true", "yes"].includes(v.toLowerCase())) : v);
        return `$${params.length}::${CAST[type]}`;
      }).join(",")})`);
      try {
        await client.query(`INSERT INTO ${qs(schema, t.name)} (${colList}) VALUES ${tuples.join(",")}`, params);
      } catch (e) {
        throw new ImportError(`Loading "${t.fileName}" failed near data row ${i + 1}: ${(e as Error).message.slice(0, 200)}`);
      }
    }
  }
}

// ───────────────────────── embeddings ─────────────────────────
async function embed(deps: ImportDeps, id: string, name: string, registry: MetadataRegistry, limits: UploadLimits, emit: (s: ImportStep, st: ProgressEvent["status"], d?: string) => void): Promise<string> {
  if (!deps.provider?.canEmbed()) {
    emit("embeddings", "skipped", "no embedding model configured — lexical retrieval will be used");
    return "skipped: EMBEDDING_MODEL is not configured";
  }
  emit("embeddings", "running");
  try {
    const ctx = createDatasetContext({ id, name, sourceType: "csv", schemaName: id, registry });
    const items = ctx.index.items.length > limits.maxEmbeddingItems ? ctx.index.items.filter((i) => i.kind === "table") : ctx.index.items;
    await syncMetadataEmbeddings(deps.pool, deps.provider, items, 32, id);
    emit("embeddings", "done", `${items.length} items`);
    return items.length < ctx.index.items.length ? "embedded (tables only — large schema)" : "embedded";
  } catch (err) {
    emit("embeddings", "skipped", "embedding failed — lexical retrieval will be used");
    return `skipped: ${(err as Error).message.slice(0, 120)}`;
  }
}

// ───────────────────────── relationships (CSV) ─────────────────────────
export interface ConfirmedRelationship {
  fromTable: string;
  fromColumn: string;
  toTable: string;
  toColumn: string;
}

/**
 * Turn user-confirmed suggestions into real constraints. Only relationships that were suggested (and verified against the
 * data) can be confirmed; each becomes a genuine FOREIGN KEY, and the metadata registry is rebuilt from the catalogs.
 */
export async function confirmRelationships(
  pool: pg.Pool,
  datasetId: string,
  confirmed: ConfirmedRelationship[],
  dismissRest: boolean,
  deps: { provider?: AIProvider; limits?: UploadLimits },
): Promise<Dataset | undefined> {
  const limits = deps.limits ?? getUploadLimits();
  const row = await getDatasetRow(pool, datasetId);
  if (!row || row.status !== "ready" || row.source_type !== "csv") throw new ImportError("Relationships can only be confirmed on a ready CSV dataset.");
  const suggestions = row.suggested_relationships ?? [];
  const same = (a: ConfirmedRelationship, b: ConfirmedRelationship) => a.fromTable === b.fromTable && a.fromColumn === b.fromColumn && a.toTable === b.toTable && a.toColumn === b.toColumn;
  for (const c of confirmed) if (!suggestions.some((s) => same(s, c))) throw new ImportError("Only suggested relationships can be confirmed.");

  const schema = assertSafeIdent(row.schema_name, "schema name");
  if (confirmed.length) {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(`SET LOCAL statement_timeout = ${limits.importTimeoutMs}`);
      let i = 0;
      for (const c of confirmed) {
        i++;
        // the target column must be a key: add PRIMARY KEY if the table has none, otherwise UNIQUE
        const pk = await client.query(
          `SELECT 1 FROM pg_constraint con JOIN pg_class r ON r.oid = con.conrelid JOIN pg_namespace n ON n.oid = r.relnamespace WHERE n.nspname = $1 AND r.relname = $2 AND con.contype = 'p'`,
          [schema, c.toTable],
        );
        const keyed = await client.query(
          `SELECT 1 FROM pg_constraint con JOIN pg_class r ON r.oid = con.conrelid JOIN pg_namespace n ON n.oid = r.relnamespace
            WHERE n.nspname = $1 AND r.relname = $2 AND con.contype IN ('p','u') AND array_length(con.conkey, 1) = 1
              AND (SELECT attname FROM pg_attribute WHERE attrelid = con.conrelid AND attnum = con.conkey[1]) = $3`,
          [schema, c.toTable, c.toColumn],
        );
        if (!keyed.rowCount) await client.query(`ALTER TABLE ${qs(schema, c.toTable)} ADD ${pk.rowCount ? "UNIQUE" : "PRIMARY KEY"} (${quoteIdent(c.toColumn)})`);
        await client.query(
          `ALTER TABLE ${qs(schema, c.fromTable)} ADD CONSTRAINT ${quoteIdent(`fk_${i}_${c.fromTable}_${c.fromColumn}`.slice(0, 60))} FOREIGN KEY (${quoteIdent(c.fromColumn)}) REFERENCES ${qs(schema, c.toTable)} (${quoteIdent(c.toColumn)})`,
        );
      }
      await client.query("COMMIT");
    } catch (err) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw new ImportError(`Could not add the relationships: ${(err as Error).message.slice(0, 200)}`);
    } finally {
      client.release();
    }
  }

  const schemaInfo: IntrospectedSchema = await introspectSchema(pool, schema, limits);
  const registry = buildRegistryFromIntrospection(schemaInfo, { previous: row.metadata ?? undefined });
  const remaining = dismissRest ? [] : suggestions.filter((s) => !confirmed.some((c) => same(s, c)));
  await pool.query(`UPDATE nl2sql.datasets SET metadata = $2, relationship_count = $3, suggested_relationships = $4, updated_at = now() WHERE id = $1`, [
    datasetId,
    JSON.stringify(registry),
    registry.relationships.length,
    remaining.length ? JSON.stringify(remaining) : null,
  ]);
  forgetContext(datasetId);
  if (deps.provider?.canEmbed()) {
    const ctx = createDatasetContext({ id: datasetId, name: row.name, sourceType: "csv", schemaName: schema, registry });
    const items = ctx.index.items.length > limits.maxEmbeddingItems ? ctx.index.items.filter((i) => i.kind === "table") : ctx.index.items;
    await syncMetadataEmbeddings(pool, deps.provider, items, 32, datasetId).catch(() => undefined);
  }
  return (await listDatasets(pool, row.session_id ?? undefined)).find((d) => d.id === datasetId);
}

// ───────────────────────── deletion / cleanup ─────────────────────────
/** Drop the schema and role of a dataset (best effort; used on failure and on delete). */
export async function dropDatasetObjects(pool: pg.Pool, schema: string, role: string | null): Promise<void> {
  assertSafeIdent(schema, "schema name");
  if (role) {
    assertSafeIdent(role, "role name");
    await pool.query(`REVOKE ${quoteIdent(role)} FROM nl2sql_readonly`).catch(() => undefined);
  }
  await pool.query(`DROP SCHEMA IF EXISTS ${quoteIdent(schema)} CASCADE`);
  if (role) {
    await pool.query(`DROP OWNED BY ${quoteIdent(role)}`).catch(() => undefined);
    await pool.query(`DROP ROLE IF EXISTS ${quoteIdent(role)}`).catch(() => undefined);
  }
}

export async function deleteDataset(pool: pg.Pool, datasetId: string): Promise<void> {
  const row = await getDatasetRow(pool, datasetId);
  if (!row || row.source_type === "builtin") throw new ImportError("This dataset cannot be deleted.", [], 403);
  await dropDatasetObjects(pool, row.schema_name, row.role_name);
  await deleteDatasetEmbeddings(pool, datasetId);
  await pool.query(`UPDATE nl2sql.datasets SET status = 'deleted', metadata = NULL, suggested_relationships = NULL, updated_at = now() WHERE id = $1`, [datasetId]);
  forgetContext(datasetId);
}

/** Uploaded datasets expire after `ttlHours`; called opportunistically on every upload. */
export async function purgeExpiredDatasets(pool: pg.Pool, limits: UploadLimits): Promise<number> {
  const res = await pool.query(
    `SELECT id FROM nl2sql.datasets WHERE source_type <> 'builtin' AND status <> 'deleted' AND created_at < now() - ($1 || ' hours')::interval LIMIT 20`,
    [String(limits.ttlHours)],
  );
  for (const r of res.rows) await deleteDataset(pool, r.id).catch(() => undefined);
  return res.rowCount ?? 0;
}
