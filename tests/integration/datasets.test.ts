import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { pointAtTestDatabase, testDatabaseUrl } from "../helpers/db";
import { loadConfig } from "@/lib/config";
import { closePools, getAdminPool } from "@/lib/database/client";
import { executeQuery, runInSandbox } from "@/lib/database/executor";
import { toValidatedSql, validateSql } from "@/lib/database/validator";
import { getBuiltinContext } from "@/lib/datasets/context";
import { confirmRelationships, deleteDataset, importDataset, purgeExpiredDatasets, type ImportRequest } from "@/lib/datasets/import-service";
import { ImportError, UNSUPPORTED_SQL_MESSAGE, getUploadLimits } from "@/lib/datasets/limits";
import { DatasetError, getDatasetDetails, listDatasets, loadDatasetContext, type Dataset } from "@/lib/datasets/store";
import { countEmbeddings, syncMetadataEmbeddings, vectorSearch } from "@/lib/metadata/embeddings";
import { listHistory } from "@/lib/history/store";
import { retrieveMetadata } from "@/lib/nl2sql/metadata-retriever";
import { processQuestion } from "@/lib/nl2sql/orchestrator";
import { hashEmbedding, HashEmbedder } from "../helpers/hash-embedder";
import { analysisOk, ScriptedProvider, sqlAnswer } from "../helpers/scripted-provider";
import { COMPANY_SQL, CUSTOMERS_CSV, ORDERS_CSV, ORPHAN_ORDERS_CSV, OTHER_SQL, TEST_LIMITS } from "../helpers/datasets";
import type { ValidatedSql } from "@/lib/types";

pointAtTestDatabase();

const config = loadConfig({ SUMMARY_MODE: "deterministic" });
let pool: pg.Pool;
const SESSION = "sess-datasets-A";
const OTHER_SESSION = "sess-datasets-B";
const raw = (sql: string) => sql as ValidatedSql;

const deps = (session = SESSION, extra: Record<string, unknown> = {}) => ({ pool, sessionId: session, clientHash: `client-${session}`, limits: TEST_LIMITS, ...extra });
const sqlReq = (text: string, name = "Company HR"): ImportRequest => ({ name, files: [{ name: "company.sql", text }], generateDescriptions: false });
const csvReq = (files: { name: string; text: string }[], name = "Shop CSV"): ImportRequest => ({ name, files, generateDescriptions: false });

beforeAll(() => {
  pool = getAdminPool();
});
afterAll(async () => {
  const rows = (await pool.query("SELECT id FROM nl2sql.datasets WHERE source_type <> 'builtin' AND status <> 'deleted'")).rows;
  for (const r of rows) await deleteDataset(pool, r.id).catch(() => undefined);
  await pool.query("DELETE FROM nl2sql.query_runs WHERE session_id LIKE 'sess-datasets%'");
  await closePools();
});

const schemaExists = async (schema: string) => (await pool.query("SELECT 1 FROM pg_namespace WHERE nspname = $1", [schema])).rowCount === 1;
const roleExists = async (role: string) => (await pool.query("SELECT 1 FROM pg_roles WHERE rolname = $1", [role])).rowCount === 1;

let company: Dataset;
let other: Dataset;

describe("SQL dataset import (company.sql)", () => {
  it("imports a schema + data file into its own isolated schema and reports what it found", async () => {
    const progress: string[] = [];
    company = await importDataset(sqlReq(COMPANY_SQL), deps(SESSION, { onProgress: (e: { step: string; status: string }) => progress.push(`${e.step}:${e.status}`) }));
    expect(company).toMatchObject({ status: "ready", sourceType: "sql", tableCount: 3, columnCount: 13, rowCount: 13, relationshipCount: 2, isBuiltin: false, name: "Company HR" });
    expect(company.id).toMatch(/^ds_[0-9a-f]{10}$/);
    expect(await schemaExists(company.id)).toBe(true);
    expect(progress).toEqual(expect.arrayContaining(["parse:done", "tables:done", "columns:done", "load:done", "relationships:done", "metadata:done", "embeddings:skipped"]));
    // the tables live in the dataset schema — and NOT in public / shop / nl2sql
    const tables = (await pool.query("SELECT tablename FROM pg_tables WHERE schemaname = $1 ORDER BY 1", [company.id])).rows.map((r) => r.tablename);
    expect(tables).toEqual(["departments", "employees", "salaries"]);
    expect((await pool.query("SELECT count(*)::int AS n FROM pg_tables WHERE tablename = 'salaries' AND schemaname IN ('public','shop','nl2sql')")).rows[0].n).toBe(0);
    expect((await pool.query("SELECT count(*)::int AS n FROM shop.departments")).rows[0].n).toBe(8); // the demo's own table is untouched
  });

  it("builds the metadata registry from the real catalog (types, nullability, PK/FK, samples, comments)", async () => {
    const d = await getDatasetDetails(pool, company.id, SESSION);
    expect(d.tables.map((t) => t.name)).toEqual(["departments", "employees", "salaries"]);
    const emp = d.tables.find((t) => t.name === "employees")!;
    expect(emp.rowCount).toBe(5);
    expect(emp.primaryKey).toEqual(["id"]);
    const dept = emp.columns.find((c) => c.name === "department_id")!;
    expect(dept).toMatchObject({ type: "integer", nullable: true, references: "departments.id" });
    // relationships come from the REAL foreign-key constraints in the SQL (one inline, one via ALTER TABLE)
    expect(d.relationships.map((r) => `${r.fromTable}.${r.fromColumn}->${r.toTable}.${r.toColumn}`).sort()).toEqual(["employees.department_id->departments.id", "salaries.employee_id->employees.id"]);
    // COMMENT ON became descriptions with source "database"; the rest are deterministic templates
    expect(d.tables.find((t) => t.name === "departments")).toMatchObject({ description: "Company departments", descriptionSource: "database" });
    expect(emp.columns.find((c) => c.name === "status")).toMatchObject({ description: "Employment status", descriptionSource: "database" });
    expect(emp.columns.find((c) => c.name === "name")!.descriptionSource).toBe("generated");
    // sample values: categorical columns list their values; PII columns and high-cardinality text list nothing
    expect(emp.columns.find((c) => c.name === "status")!.sampleValues).toEqual(["active", "left", "on_leave"]);
    expect(emp.columns.find((c) => c.name === "email")!.sampleValues).toBeUndefined();
    expect(emp.columns.find((c) => c.name === "name")!.sampleValues).toBeUndefined();
    expect(JSON.stringify(d)).not.toContain("ada@corp.example");
    expect(d.suggestedQuestions.length).toBeGreaterThan(0);
  });

  it("creates a dedicated read-only role and enables Row Level Security", async () => {
    const role = `nl2sql_ro_${company.id.slice(3)}`;
    expect(await roleExists(role)).toBe(true);
    const rls = await pool.query("SELECT bool_and(rowsecurity) AS all_rls FROM pg_tables WHERE schemaname = $1", [company.id]);
    expect(rls.rows[0].all_rls).toBe(true);
    const privs = await pool.query("SELECT has_table_privilege($1, $2 || '.employees', 'SELECT') AS sel, has_table_privilege($1, $2 || '.employees', 'INSERT') AS ins", [role, company.id]);
    expect(privs.rows[0]).toEqual({ sel: true, ins: false });
  });
});

describe("NL2SQL pipeline on the uploaded dataset (upload → metadata → routing → SQL → execution → result)", () => {
  const SQL = "SELECT d.name AS department, ROUND(AVG(s.amount), 2) AS average_salary FROM departments d JOIN employees e ON e.department_id = d.id JOIN salaries s ON s.employee_id = e.id GROUP BY d.name ORDER BY average_salary DESC LIMIT 1";

  it("answers 'Which department has the highest average salary?' against the uploaded data", async () => {
    const provider = new ScriptedProvider({ "question analysis": [analysisOk()], "SQL generation": [sqlAnswer(SQL)] });
    const res = await processQuestion({ question: "Which department has the highest average salary?", datasetId: company.id }, { sessionId: SESSION, clientHash: "c1" }, { provider, config, useVectorSearch: false });
    expect(res.success).toBe(true);
    expect(res.dataset).toEqual({ id: company.id, name: "Company HR" });
    expect(res.rows).toEqual([{ department: "Engineering", average_salary: 127500 }]); // (120000+135000)/2, computed from the uploaded rows
    expect(res.tablesUsed.sort()).toEqual(["departments", "employees", "salaries"]);
    expect(res.trace.datasetId).toBe(company.id);
    expect(res.trace.routing?.selectedTables).toEqual(expect.arrayContaining(["departments", "salaries"]));
    expect(res.trace.subSchema?.tables.sort()).toEqual(["departments", "employees", "salaries"]);
    // the SQL generator got the uploaded schema (and only it), including the generated business context
    const prompt = provider.callsFor("SQL generation")[0].prompt;
    expect(prompt).toContain("TABLE departments — Company departments");
    expect(prompt).toContain("FK → departments.id");
    expect(prompt).not.toContain("TABLE orders");
    expect(prompt).not.toContain("ada@corp.example");
    expect(prompt).not.toContain("Ada Byron"); // no row data is sent to the model
  });

  it("stores the dataset id with the run and keeps history per dataset", async () => {
    const provider = new ScriptedProvider({ "question analysis": [analysisOk()], "SQL generation": [sqlAnswer("SELECT COUNT(*) AS n FROM customers")] });
    const demo = await processQuestion("How many customers are there?", { sessionId: SESSION }, { provider, config, useVectorSearch: false });
    expect(demo.dataset).toEqual({ id: "demo", name: "E-commerce Demo" });

    const forCompany = await listHistory(pool, SESSION, 20, { datasetId: company.id });
    expect(forCompany.length).toBeGreaterThan(0);
    expect(forCompany.every((h) => h.datasetId === company.id && h.datasetName === "Company HR")).toBe(true);
    expect(forCompany.some((h) => h.question.includes("customers are there"))).toBe(false);
    const forDemo = await listHistory(pool, SESSION, 20, { datasetId: "demo" });
    expect(forDemo.some((h) => h.question.includes("customers are there"))).toBe(true);
    expect(forDemo.every((h) => h.datasetId === "demo")).toBe(true);
    const all = await listHistory(pool, SESSION, 50, { datasetId: "all" });
    expect(new Set(all.map((h) => h.datasetId))).toEqual(new Set(["demo", company.id]));
    expect((await pool.query("SELECT dataset_id FROM nl2sql.query_runs WHERE id = $1", [demo.runId])).rows[0].dataset_id).toBe("demo");
  });

  it("a dataset-A query cannot use the demo tables (validator) and a demo query cannot use dataset tables", async () => {
    const provider = new ScriptedProvider({
      "question analysis": [analysisOk()],
      "SQL generation": [sqlAnswer("SELECT * FROM shop.orders")],
      "SQL correction": [{ diagnosis: "orders is not part of this dataset", sql: "SELECT COUNT(*) AS n FROM employees", explanation: "", tables_used: [], assumptions: [] }],
    });
    const res = await processQuestion({ question: "How many employees are there?", datasetId: company.id }, { sessionId: SESSION }, { provider, config, useVectorSearch: false });
    expect(res.corrections[0].error.code).toBe("FORBIDDEN_SCHEMA");
    expect(res.success).toBe(true);
    expect(res.rows).toEqual([{ n: 5 }]);
  });

  it("refuses unknown datasets and datasets owned by another session", async () => {
    const provider = new ScriptedProvider({});
    const missing = await processQuestion({ question: "How many rows?", datasetId: "ds_0000000000" }, { sessionId: SESSION }, { provider, config, useVectorSearch: false });
    expect(missing.error?.code).toBe("DATASET_NOT_FOUND");
    const stranger = await processQuestion({ question: "How many employees are there?", datasetId: company.id }, { sessionId: OTHER_SESSION }, { provider, config, useVectorSearch: false });
    expect(stranger.error?.code).toBe("DATASET_NOT_FOUND");
    expect(provider.calls).toHaveLength(0);
    await expect(loadDatasetContext(pool, company.id, OTHER_SESSION)).rejects.toBeInstanceOf(DatasetError);
    await expect(loadDatasetContext(pool, company.id, undefined)).rejects.toBeInstanceOf(DatasetError);
    expect((await listDatasets(pool, OTHER_SESSION)).map((d) => d.id)).toEqual(["demo"]); // the other session sees only the demo
  });
});

describe("dataset isolation — Dataset A cannot query Dataset B", () => {
  it("two datasets with the same table name keep separate data", async () => {
    other = await importDataset(sqlReq(OTHER_SQL, "Ops"), deps(SESSION));
    const a = await loadDatasetContext(pool, company.id, SESSION);
    const b = await loadDatasetContext(pool, other.id, SESSION);
    const ra = await executeQuery({ sql: toValidatedSql(await validateSql("SELECT COUNT(*) AS n FROM employees", a)), dataset: a });
    const rb = await executeQuery({ sql: toValidatedSql(await validateSql("SELECT COUNT(*) AS n FROM employees", b)), dataset: b });
    expect(ra.success && ra.rows[0].n).toBe(5);
    expect(rb.success && rb.rows[0].n).toBe(2);
  });

  it("the validator rejects the other dataset's schema by name", async () => {
    const a = await loadDatasetContext(pool, company.id, SESSION);
    const r = await validateSql(`SELECT * FROM ${other.id}.employees`, a);
    expect(r.valid).toBe(false);
    expect(r.issues[0].code).toBe("FORBIDDEN_SCHEMA");
  });

  it("executeQuery re-validates: a forged brand still cannot reach another dataset, the app schema or the demo", async () => {
    const a = await loadDatasetContext(pool, company.id, SESSION);
    for (const sql of [`SELECT * FROM ${other.id}.employees`, "SELECT * FROM nl2sql.query_runs", "SELECT * FROM nl2sql.datasets", "SELECT * FROM shop.orders", "SELECT * FROM pg_shadow"]) {
      const res = await executeQuery({ sql: raw(sql), dataset: a });
      expect(res.success, sql).toBe(false);
      if (!res.success) expect(res.error.code).toBe("VALIDATION_FAILED");
    }
  });

  it("even with validation bypassed, the DATABASE refuses cross-dataset and application reads (per-dataset role)", async () => {
    const a = await loadDatasetContext(pool, company.id, SESSION);
    const b = await loadDatasetContext(pool, other.id, SESSION);
    const demo = getBuiltinContext();
    const denied = async (sql: string, ctx: typeof a) => {
      const res = await runInSandbox({ sql: raw(sql), dataset: ctx });
      expect(res.success, sql).toBe(false);
      if (!res.success) expect(res.error.category).toBe("permission");
    };
    await denied(`SELECT * FROM ${other.id}.employees`, a); // A → B
    await denied(`SELECT * FROM ${company.id}.employees`, b); // B → A
    await denied("SELECT * FROM shop.orders", a); // A → demo
    await denied("SELECT * FROM nl2sql.query_runs", a); // A → application schema
    await denied("SELECT * FROM nl2sql.datasets", a);
    await denied(`SELECT * FROM ${company.id}.employees`, demo); // demo → A
  });

  it("with validation bypassed, uploaded datasets are read-only at the database level", async () => {
    const a = await loadDatasetContext(pool, company.id, SESSION);
    for (const sql of ["DELETE FROM employees", "UPDATE employees SET name = 'x'", "DROP TABLE employees", "TRUNCATE employees", "INSERT INTO employees (id, name) VALUES (99, 'x')", "CREATE TABLE evil (id int)"]) {
      const res = await runInSandbox({ sql: raw(sql), dataset: a });
      expect(res.success, sql).toBe(false);
    }
    const n = await pool.query(`SELECT count(*)::int AS n FROM ${company.id}.employees`);
    expect(n.rows[0].n).toBe(5);
    expect((await pool.query("SELECT to_regclass($1) AS t", [`${company.id}.evil`])).rows[0].t).toBeNull();
  });

  it("the dataset role has no privileges outside its own schema", async () => {
    const role = `nl2sql_ro_${company.id.slice(3)}`;
    const r = await pool.query(
      `SELECT has_schema_privilege($1, 'shop', 'USAGE') AS shop, has_schema_privilege($1, 'nl2sql', 'USAGE') AS app,
              has_schema_privilege($1, $2, 'USAGE') AS other, has_schema_privilege($1, $3, 'USAGE') AS mine`,
      [role, other.id, company.id],
    );
    expect(r.rows[0]).toEqual({ shop: false, app: false, other: false, mine: true });
  });

  it("generated SQL cannot reach PostgreSQL catalogs, session identity, config or sleep functions (validator layer)", async () => {
    const a = await loadDatasetContext(pool, company.id, SESSION);
    for (const sql of [
      "SELECT * FROM pg_class",
      "SELECT * FROM pg_catalog.pg_class",
      "SELECT * FROM pg_namespace",
      "SELECT * FROM pg_roles",
      "SELECT * FROM pg_stat_activity",
      "SELECT * FROM pg_tables",
      "SELECT * FROM information_schema.tables",
      "SELECT * FROM information_schema.columns",
      "SELECT current_user",
      "SELECT current_setting('search_path')",
      "SELECT set_config('search_path', 'nl2sql', false)",
      "SELECT version()",
      "SELECT pg_sleep(5)",
      "SELECT pg_read_file('/etc/passwd')",
      "SELECT lo_import('/etc/passwd')",
      "SELECT * FROM employees e, pg_class c",
      "SELECT (SELECT relname FROM pg_class LIMIT 1) FROM employees",
      "WITH x AS (SELECT * FROM pg_namespace) SELECT * FROM x",
    ]) {
      const res = await executeQuery({ sql: raw(sql), dataset: a });
      expect(res.success, sql).toBe(false);
      if (!res.success) expect(res.error.code, sql).toBe("VALIDATION_FAILED");
    }
  });

  it("KNOWN LIMIT (documented): the database itself does not hide catalog NAMES — PostgreSQL lets every role read pg_catalog — so that protection is the validator's, not the role's", async () => {
    const a = await loadDatasetContext(pool, company.id, SESSION);
    const res = await runInSandbox({ sql: raw(`SELECT nspname FROM pg_namespace WHERE nspname = '${other.id}'`), dataset: a });
    expect(res.success).toBe(true); // names are visible at the DB level ...
    // ... but not the data behind them (proved above), and generated SQL never gets here because validateSql refuses catalog names.
    const data = await runInSandbox({ sql: raw(`SELECT * FROM ${other.id}.employees`), dataset: a });
    expect(data.success).toBe(false);
  });

  it("the demo dataset still works unchanged", async () => {
    const demo = getBuiltinContext();
    const res = await executeQuery({ sql: toValidatedSql(await validateSql("SELECT COUNT(*) AS n FROM orders", demo)), dataset: demo });
    expect(res.success && (res.rows[0].n as number)).toBeGreaterThan(1000);
    const list = await listDatasets(pool, SESSION);
    expect(list[0]).toMatchObject({ id: "demo", tableCount: 20, isBuiltin: true, status: "ready", name: "E-commerce Demo" });
    expect(list[0].rowCount).toBeGreaterThan(5000);
  });
});

describe("dangerous or broken uploads never leave anything behind", () => {
  const schemasBefore = async () => (await pool.query("SELECT count(*)::int AS n FROM pg_namespace WHERE starts_with(nspname, 'ds_')")).rows[0].n as number;
  const rolesBefore = async () => (await pool.query("SELECT count(*)::int AS n FROM pg_roles WHERE starts_with(rolname, 'nl2sql_ro_')")).rows[0].n as number;
  const appTableCounts = async () => (await pool.query("SELECT (SELECT count(*) FROM nl2sql.query_runs)::int AS runs, (SELECT count(*) FROM nl2sql.metadata_embeddings)::int AS emb, (SELECT count(*) FROM shop.customers)::int AS customers")).rows[0];

  it("rejects dangerous SQL as 'unsupported statements' without executing any part of the file", async () => {
    const s0 = await schemasBefore();
    const r0 = await rolesBefore();
    const app0 = await appTableCounts();
    const evil = [
      "DROP TABLE nl2sql.query_runs;",
      "DELETE FROM nl2sql.query_runs;",
      "INSERT INTO nl2sql.query_runs (user_question, status) VALUES ('pwned', 'error');",
      "CREATE ROLE hacker SUPERUSER LOGIN;",
      "GRANT ALL ON ALL TABLES IN SCHEMA nl2sql TO PUBLIC;",
      "COPY shop.customers TO PROGRAM 'echo hi';",
      "CREATE EXTENSION dblink;",
      "SELECT pg_read_file('/etc/passwd');",
    ];
    for (const stmt of evil) {
      await expect(importDataset(sqlReq(`CREATE TABLE innocent (id int); INSERT INTO innocent VALUES (1);\n${stmt}\n`, "evil"), deps(SESSION))).rejects.toMatchObject({ message: UNSUPPORTED_SQL_MESSAGE });
    }
    expect(await schemasBefore()).toBe(s0); // not even the valid CREATE TABLE ran
    expect(await rolesBefore()).toBe(r0);
    expect(await appTableCounts()).toEqual(app0);
    expect((await pool.query("SELECT to_regclass('public.innocent') AS t")).rows[0].t).toBeNull();
    expect((await pool.query("SELECT count(*)::int AS n FROM pg_roles WHERE rolname = 'hacker'")).rows[0].n).toBe(0);
    // every attempt is recorded as a failed dataset with the reason — never as ready
    const failed = (await listDatasets(pool, SESSION)).filter((d) => d.status === "failed");
    expect(failed.length).toBeGreaterThanOrEqual(evil.length);
    expect(failed.every((d) => /unsupported statements/.test(d.error ?? ""))).toBe(true);
    expect(failed.every((d) => d.tableCount === 0)).toBe(true);
  });

  it("rejects a table named like a system catalog (would shadow pg_catalog) and creates nothing", async () => {
    const before = (await pool.query("SELECT count(*)::int AS n FROM pg_namespace WHERE nspname LIKE 'ds\\_%'")).rows[0].n;
    await expect(importDataset(sqlReq("CREATE TABLE pg_class (id int); INSERT INTO pg_class VALUES (1);", "Shadow"), deps())).rejects.toBeInstanceOf(ImportError);
    const after = (await pool.query("SELECT count(*)::int AS n FROM pg_namespace WHERE nspname LIKE 'ds\\_%'")).rows[0].n;
    expect(after).toBe(before);
  });

  it("single-row INSERTs are merged for speed, load every row, and a failure inside a merged batch still names the exact original line", async () => {
    const ok = Array.from({ length: 2500 }, (_, i) => `INSERT INTO t (id, label) VALUES (${i}, 'row ${i}');`).join("\n");
    const good = await importDataset(sqlReq(`CREATE TABLE t (id int PRIMARY KEY, label text);\n${ok}\n`, "Merged loads"), deps(SESSION));
    expect(good.rowCount).toBe(2500);
    const count = await pool.query(`SELECT count(*)::int AS n, min(label) AS first, max(id) AS last FROM ${good.id}.t`);
    expect(count.rows[0]).toMatchObject({ n: 2500, first: "row 0", last: 2499 });
    await deleteDataset(pool, good.id);

    // rows on lines 2..11; line 8 repeats id 3 (line 5) -> the reported line must be 8, not the merged batch's first line
    const lines = ["CREATE TABLE t (id int PRIMARY KEY);", ...[0, 1, 2, 3, 4, 5, 3, 7, 8, 9].map((id) => `INSERT INTO t VALUES (${id});`)];
    const err = await importDataset(sqlReq(lines.join("\n"), "Dupe line"), deps(SESSION)).catch((e) => e);
    expect(err).toBeInstanceOf(ImportError);
    expect(err.message).toMatch(/line 8\b/);
  });

  it("rolls back completely when loading fails at run time (duplicate primary key)", async () => {
    const s0 = await schemasBefore();
    const r0 = await rolesBefore();
    await expect(importDataset(sqlReq("CREATE TABLE t (id int PRIMARY KEY); INSERT INTO t VALUES (1), (1);", "dupes"), deps(SESSION))).rejects.toBeInstanceOf(ImportError);
    expect(await schemasBefore()).toBe(s0);
    expect(await rolesBefore()).toBe(r0);
    const failed = (await listDatasets(pool, SESSION)).find((d) => d.name === "dupes");
    expect(failed).toMatchObject({ status: "failed" });
    expect(failed!.error).toMatch(/line 1|duplicate key/);
  });

  it("rolls back when a foreign key points at a missing table", async () => {
    const s0 = await schemasBefore();
    await expect(importDataset(sqlReq("CREATE TABLE a (id int, b_id int REFERENCES b(id));", "badfk"), deps(SESSION))).rejects.toBeInstanceOf(ImportError);
    expect(await schemasBefore()).toBe(s0);
  });

  it("invalid SQL fails with a readable reason and a failed dataset record", async () => {
    await expect(importDataset(sqlReq("CREATE TABLE (oops", "broken"), deps(SESSION))).rejects.toThrow(/could not be parsed/);
    const failed = (await listDatasets(pool, SESSION)).find((d) => d.name === "broken");
    expect(failed).toMatchObject({ status: "failed" });
    expect(failed!.error).toMatch(/parsed/);
  });

  it("failed datasets cannot be queried", async () => {
    const failed = (await listDatasets(pool, SESSION)).find((d) => d.status === "failed")!;
    const res = await processQuestion({ question: "How many rows are there?", datasetId: failed.id }, { sessionId: SESSION }, { provider: new ScriptedProvider({}), config });
    expect(res.error?.code).toBe("DATASET_NOT_READY");
  });

  it("rejects mixed .sql and .csv, unsupported extensions and multiple .sql files", async () => {
    await expect(importDataset({ name: "x", files: [{ name: "a.sql", text: "CREATE TABLE a (id int);" }, { name: "b.csv", text: "id\n1\n" }], generateDescriptions: false }, deps(SESSION))).rejects.toThrow(/not both/);
    await expect(importDataset({ name: "x", files: [{ name: "a.xlsx", text: "x" }], generateDescriptions: false }, deps(SESSION))).rejects.toThrow(/Unsupported file type/);
    await expect(importDataset({ name: "x", files: [{ name: "a.sql", text: "CREATE TABLE a (id int);" }, { name: "b.sql", text: "CREATE TABLE b (id int);" }], generateDescriptions: false }, deps(SESSION))).rejects.toThrow(/single .sql/);
  });
});

describe("CSV dataset import + relationship review", () => {
  let csv: Dataset;
  const files = [
    { name: "customers.csv", text: CUSTOMERS_CSV },
    { name: "orders.csv", text: ORDERS_CSV },
  ];

  it("creates tables with inferred types and loads the rows", async () => {
    csv = await importDataset(csvReq(files), deps(SESSION));
    expect(csv).toMatchObject({ status: "ready", sourceType: "csv", tableCount: 2, columnCount: 9, rowCount: 9 });
    const d = await getDatasetDetails(pool, csv.id, SESSION);
    const cust = d.tables.find((t) => t.name === "customers")!;
    expect(Object.fromEntries(cust.columns.map((c) => [c.name, c.type]))).toEqual({ id: "integer", name: "text", city: "text", signup_date: "date", vip: "boolean" });
    const count = await pool.query(`SELECT count(*)::int AS n FROM ${csv.id}.customers WHERE vip`);
    expect(count.rows[0].n).toBe(2);
    expect((await pool.query(`SELECT name FROM ${csv.id}.customers WHERE id = 3`)).rows[0].name).toBe("Chloé"); // non-ASCII survives
  });

  it("does NOT present inferred relationships as guaranteed: they are suggestions with evidence, not metadata", async () => {
    const d = await getDatasetDetails(pool, csv.id, SESSION);
    expect(d.relationships).toEqual([]); // nothing is in the registry yet
    expect(csv.relationshipCount).toBe(0);
    expect(csv.pendingRelationships).toBe(1);
    expect(d.suggestedRelationships).toEqual([expect.objectContaining({ fromTable: "orders", fromColumn: "customer_id", toTable: "customers", toColumn: "id" })]);
    expect(d.suggestedRelationships[0].evidence).toMatch(/all \d+ distinct non-null values/);
    // no real constraint exists in the database either
    expect((await pool.query("SELECT count(*)::int AS n FROM pg_constraint c JOIN pg_namespace n ON n.oid = c.connamespace WHERE n.nspname = $1 AND c.contype IN ('f','p')", [csv.id])).rows[0].n).toBe(0);
  });

  it("does not even suggest a relationship when the data contradicts it (orphan values)", async () => {
    const orphan = await importDataset(csvReq([{ name: "customers.csv", text: CUSTOMERS_CSV }, { name: "orders.csv", text: ORPHAN_ORDERS_CSV }], "Orphans"), deps(SESSION));
    expect(orphan.pendingRelationships).toBe(0);
    await deleteDataset(pool, orphan.id);
  });

  it("only suggested relationships can be confirmed; confirmed ones become real foreign keys and enter the metadata", async () => {
    await expect(confirmRelationships(pool, csv.id, [{ fromTable: "orders", fromColumn: "amount", toTable: "customers", toColumn: "id" }], false, {})).rejects.toThrow(/Only suggested/);
    await confirmRelationships(pool, csv.id, [{ fromTable: "orders", fromColumn: "customer_id", toTable: "customers", toColumn: "id" }], false, {});
    const fk = await pool.query("SELECT conname FROM pg_constraint c JOIN pg_namespace n ON n.oid = c.connamespace WHERE n.nspname = $1 AND c.contype = 'f'", [csv.id]);
    expect(fk.rowCount).toBe(1);
    expect((await pool.query("SELECT count(*)::int AS n FROM pg_constraint c JOIN pg_namespace n ON n.oid = c.connamespace WHERE n.nspname = $1 AND c.contype = 'p'", [csv.id])).rows[0].n).toBe(1); // target key made a PK
    const d = await getDatasetDetails(pool, csv.id, SESSION);
    expect(d.relationships).toHaveLength(1);
    expect(d.dataset.relationshipCount).toBe(1);
    expect(d.suggestedRelationships).toEqual([]);
    // and the FK is enforced by the database from now on
    await expect(pool.query(`INSERT INTO ${csv.id}.orders (order_id, customer_id, amount) VALUES (999, 424242, 1)`)).rejects.toThrow(/foreign key/);
  });

  it("answers a join question over the confirmed CSV relationship", async () => {
    const SQL = "SELECT c.city, ROUND(SUM(o.amount), 2) AS total FROM orders o JOIN customers c ON c.id = o.customer_id GROUP BY c.city ORDER BY total DESC";
    const provider = new ScriptedProvider({ "question analysis": [analysisOk()], "SQL generation": [sqlAnswer(SQL)] });
    const res = await processQuestion({ question: "What is the total order amount per city?", datasetId: csv.id }, { sessionId: SESSION }, { provider, config, useVectorSearch: false });
    expect(res.success).toBe(true);
    expect(res.rows[0]).toEqual({ city: "Berlin", total: 99.99 });
    expect(res.trace.subSchema?.relationships).toEqual(["orders.customer_id = customers.id"]);
  });

  it("dismissing suggestions leaves the metadata unchanged", async () => {
    const d2 = await importDataset(csvReq(files, "Dismiss"), deps(SESSION));
    await confirmRelationships(pool, d2.id, [], true, {});
    const d = await getDatasetDetails(pool, d2.id, SESSION);
    expect(d.suggestedRelationships).toEqual([]);
    expect(d.relationships).toEqual([]);
  });
});

describe("limits, quotas, lifecycle", () => {
  it("enforces row / table limits during import and marks the dataset failed", async () => {
    const tiny = { ...TEST_LIMITS, maxRows: 3 };
    await expect(importDataset(csvReq([{ name: "big.csv", text: `id\n${"1\n".repeat(10)}` }], "TooBig"), deps(SESSION, { limits: tiny }))).rejects.toThrow(/Too many rows/);
    expect((await listDatasets(pool, SESSION)).find((d) => d.name === "TooBig")).toMatchObject({ status: "failed" });
  });

  it("enforces the import time budget: a too-slow import is cancelled with a friendly message and leaves nothing behind", async () => {
    const rows = Array.from({ length: 4000 }, (_, i) => `(${i}, 'value number ${i} with some padding text to make the row heavier')`).join(",");
    const slow = `CREATE TABLE big (id int PRIMARY KEY, note text); INSERT INTO big VALUES ${rows};`;
    const before = (await pool.query("SELECT count(*)::int AS n FROM pg_namespace WHERE nspname LIKE 'ds\\_%'")).rows[0].n;
    const err = await importDataset(sqlReq(slow, "Too slow"), deps(SESSION, { limits: { ...TEST_LIMITS, importTimeoutMs: 1, maxRows: 10_000 } })).catch((e) => e);
    expect(err).toBeInstanceOf(ImportError);
    expect(err.message).toMatch(/took too long|cancelled/i);
    expect(err.message).not.toMatch(/57014|statement_timeout|canceling/i); // no database internals
    expect((await pool.query("SELECT count(*)::int AS n FROM pg_namespace WHERE nspname LIKE 'ds\\_%'")).rows[0].n).toBe(before);
    const failed = await pool.query("SELECT status, error FROM nl2sql.datasets WHERE name = 'Too slow' ORDER BY created_at DESC LIMIT 1");
    expect(failed.rows[0].status).toBe("failed");
  });

  it("limits how many datasets one session can hold and how often one client can upload", async () => {
    const session = "sess-datasets-quota";
    const limits = { ...TEST_LIMITS, maxDatasetsPerSession: 1, maxUploadsPerHour: 1000 };
    const first = await importDataset(csvReq([{ name: "a.csv", text: "id\n1\n" }], "Q1"), { pool, sessionId: session, clientHash: "quota-client", limits });
    await expect(importDataset(csvReq([{ name: "b.csv", text: "id\n1\n" }], "Q2"), { pool, sessionId: session, clientHash: "quota-client", limits })).rejects.toMatchObject({ httpStatus: 409 });
    await deleteDataset(pool, first.id);
    const rate = { ...TEST_LIMITS, maxUploadsPerHour: 1, maxDatasetsPerSession: 50 };
    const ok = await importDataset(csvReq([{ name: "a.csv", text: "id\n1\n" }], "R1"), { pool, sessionId: "sess-datasets-rate", clientHash: "rate-client", limits: rate });
    await expect(importDataset(csvReq([{ name: "b.csv", text: "id\n1\n" }], "R2"), { pool, sessionId: "sess-datasets-rate", clientHash: "rate-client", limits: rate })).rejects.toMatchObject({ httpStatus: 429 });
    await deleteDataset(pool, ok.id);
  });

  it("reports an import that never finished as failed (stale 'processing')", async () => {
    await pool.query(`INSERT INTO nl2sql.datasets (id, name, source_type, status, schema_name, session_id, created_at) VALUES ('ds_stale00000','Stale','sql','processing','ds_stale00000',$1, now() - interval '1 hour')`, [SESSION]);
    const d = (await listDatasets(pool, SESSION)).find((x) => x.id === "ds_stale00000");
    expect(d).toMatchObject({ status: "failed" });
    expect(d!.error).toMatch(/did not finish/);
    await pool.query("DELETE FROM nl2sql.datasets WHERE id = 'ds_stale00000'");
  });

  it("deleting a dataset drops its schema, role and embeddings, hides it, and leaves other datasets intact", async () => {
    const tmp = await importDataset(sqlReq("CREATE TABLE x (id int); INSERT INTO x VALUES (1);", "ToDelete"), deps(SESSION, { provider: new HashEmbedder() }));
    const role = `nl2sql_ro_${tmp.id.slice(3)}`;
    expect(await schemaExists(tmp.id)).toBe(true);
    expect(await roleExists(role)).toBe(true);
    expect(await countEmbeddings(pool, tmp.id)).toBeGreaterThan(0);
    await deleteDataset(pool, tmp.id);
    expect(await schemaExists(tmp.id)).toBe(false);
    expect(await roleExists(role)).toBe(false);
    expect(await countEmbeddings(pool, tmp.id)).toBe(0);
    expect((await listDatasets(pool, SESSION)).some((d) => d.id === tmp.id)).toBe(false);
    await expect(loadDatasetContext(pool, tmp.id, SESSION)).rejects.toBeInstanceOf(DatasetError);
    expect(await schemaExists(company.id)).toBe(true); // others untouched
    await expect(deleteDataset(pool, "demo")).rejects.toMatchObject({ httpStatus: 403 });
    expect((await pool.query("SELECT count(*)::int AS n FROM shop.orders")).rows[0].n).toBeGreaterThan(1000);
  });

  it("uploaded datasets expire after the TTL", async () => {
    const tmp = await importDataset(sqlReq("CREATE TABLE x (id int);", "Expiring"), deps(SESSION));
    await pool.query("UPDATE nl2sql.datasets SET created_at = now() - interval '10 days' WHERE id = $1", [tmp.id]);
    await purgeExpiredDatasets(pool, getUploadLimits({ DATASET_TTL_HOURS: "72" }));
    expect(await schemaExists(tmp.id)).toBe(false);
    expect((await pool.query("SELECT status FROM nl2sql.datasets WHERE id = $1", [tmp.id])).rows[0].status).toBe("deleted");
  });
});

describe("optional LLM descriptions and embeddings are dataset-scoped", () => {
  it("marks generated descriptions as llm, ignores invented tables/columns, and never overrides database comments", async () => {
    const provider = new ScriptedProvider({
      "dataset descriptions": [{ tables: [{ name: "departments", description: "LLM: the departments", columns: [{ name: "name", description: "LLM: department name" }, { name: "nope", description: "invented" }] }, { name: "invented_table", description: "x", columns: [] }, { name: "employees", description: "LLM: staff members", columns: [] }] }],
    });
    const ds = await importDataset({ ...sqlReq(COMPANY_SQL, "Described"), generateDescriptions: true }, deps(SESSION, { provider }));
    expect(ds.descriptionsGeneratedBy).toBe("llm");
    const d = await getDatasetDetails(pool, ds.id, SESSION);
    expect(d.tables.map((t) => t.name)).toEqual(["departments", "employees", "salaries"]); // structure untouched
    expect(d.tables.find((t) => t.name === "departments")).toMatchObject({ description: "Company departments", descriptionSource: "database" }); // DB comment wins
    expect(d.tables.find((t) => t.name === "employees")).toMatchObject({ description: "LLM: staff members", descriptionSource: "llm" });
    expect(d.tables[0].columns.find((c) => c.name === "name")).toMatchObject({ description: "LLM: department name", descriptionSource: "llm" });
    expect(d.tables[0].columns.map((c) => c.name)).not.toContain("nope");
    expect(provider.callsFor("dataset descriptions")[0].prompt).not.toContain("ada@corp.example");
    await deleteDataset(pool, ds.id);
  });

  it("descriptions are optional: a failing model just falls back to generated text", async () => {
    const provider = new ScriptedProvider({ "dataset descriptions": [new Error("provider down")] });
    const ds = await importDataset({ ...sqlReq(COMPANY_SQL, "NoLlm"), generateDescriptions: true }, deps(SESSION, { provider }));
    expect(ds.status).toBe("ready");
    expect(ds.descriptionsGeneratedBy).toBeUndefined();
    await deleteDataset(pool, ds.id);
  });

  it("embeddings carry the dataset id; a search for one dataset never returns another's metadata", async () => {
    const embedder = new HashEmbedder();
    const a = await loadDatasetContext(pool, company.id, SESSION);
    const b = await loadDatasetContext(pool, other.id, SESSION);
    await syncMetadataEmbeddings(pool, embedder, a.index.items, 32, company.id);
    await syncMetadataEmbeddings(pool, embedder, b.index.items, 32, other.id);
    const rows = (await pool.query("SELECT dataset_id, count(*)::int AS n FROM nl2sql.metadata_embeddings WHERE dataset_id IN ($1,$2) GROUP BY 1", [company.id, other.id])).rows;
    expect(Object.fromEntries(rows.map((r) => [r.dataset_id, r.n]))).toEqual({ [company.id]: a.index.items.length, [other.id]: b.index.items.length });

    const q = hashEmbedding("employees name team");
    const hitsA = await vectorSearch(pool, q, 50, "hash-768", company.id);
    const hitsB = await vectorSearch(pool, q, 50, "hash-768", other.id);
    expect(hitsA.every((h) => a.index.items.some((i) => i.id === h.itemId))).toBe(true);
    expect(hitsB.every((h) => b.index.items.some((i) => i.id === h.itemId))).toBe(true);
    expect(hitsA.some((h) => h.itemId === "column:employees.team")).toBe(false); // exists only in dataset B
    expect(hitsB.some((h) => h.itemId === "column:employees.team")).toBe(true);

    // retrieval through the pipeline is scoped the same way
    const ra = await retrieveMetadata("employees team", { dataset: a, vector: { provider: embedder, pool } });
    expect(ra.method).toBe("hybrid");
    expect(ra.items.some((i) => i.id === "column:employees.team")).toBe(false);
    const rb = await retrieveMetadata("employees team", { dataset: b, vector: { provider: embedder, pool } });
    expect(rb.items.some((i) => i.id === "column:employees.team")).toBe(true);
    // the demo's embeddings are separate from both
    expect((await vectorSearch(pool, q, 50, "hash-768", "demo")).every((h) => !hitsA.some((x) => x.itemId === h.itemId && false))).toBe(true);
  });

  it("creates embeddings during import when an embedding model is configured, and falls back to lexical when not", async () => {
    const withEmb = await importDataset(sqlReq("CREATE TABLE gadgets (id int PRIMARY KEY, label text);", "Emb"), deps(SESSION, { provider: new HashEmbedder() }));
    expect(withEmb.embeddingStatus).toBe("embedded");
    expect(await countEmbeddings(pool, withEmb.id)).toBeGreaterThan(0);
    expect(await countEmbeddings(pool, company.id)).toBeGreaterThanOrEqual(0);
    const without = await importDataset(sqlReq("CREATE TABLE gizmos (id int PRIMARY KEY);", "NoEmb"), deps(SESSION));
    expect(without.embeddingStatus).toMatch(/^skipped/);
    const ctx = await loadDatasetContext(pool, without.id, SESSION);
    const r = await retrieveMetadata("how many gizmos", { dataset: ctx });
    expect(r.method).toBe("lexical");
    expect(r.items[0].id).toContain("gizmos");
    await deleteDataset(pool, withEmb.id);
    await deleteDataset(pool, without.id);
  });
});

describe("registry of application tables stays protected", () => {
  it("RLS is enabled on the datasets table and the dataset roles cannot read it", async () => {
    expect((await pool.query("SELECT rowsecurity FROM pg_tables WHERE schemaname = 'nl2sql' AND tablename = 'datasets'")).rows[0].rowsecurity).toBe(true);
    const c = new pg.Client({ connectionString: testDatabaseUrl() });
    await c.connect();
    try {
      await c.query("BEGIN");
      await c.query(`SET LOCAL ROLE nl2sql_ro_${company.id.slice(3)}`);
      await expect(c.query("SELECT * FROM nl2sql.datasets")).rejects.toThrow(/permission denied/);
    } finally {
      await c.query("ROLLBACK");
      await c.end();
    }
  });
});
