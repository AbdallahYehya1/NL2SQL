import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { migrate, seed } from "../../scripts/db";
import { closePools, getAdminPool } from "@/lib/database/client";
import { executeQuery, runInSandbox } from "@/lib/database/executor";
import { toValidatedSql, validateSql } from "@/lib/database/validator";
import { getBuiltinContext } from "@/lib/datasets/context";
import { deleteDataset, importDataset, purgeExpiredDatasets } from "@/lib/datasets/import-service";
import { loadDatasetContext, type Dataset } from "@/lib/datasets/store";
import { COMPANY_SQL, OTHER_SQL, TEST_LIMITS } from "../helpers/datasets";
import type { ValidatedSql } from "@/lib/types";

/**
 * Simulates the permission model of a managed PostgreSQL such as Supabase on a local server:
 *
 *   - the application connects as an ordinary role that has CREATEROLE but is NOT a superuser (Supabase's `postgres` role),
 *   - the `vector` extension lives in an `extensions` schema that is on the role's search_path (as on Supabase),
 *   - generated SQL logs in through a dedicated `nl2sql_readonly` login (the documented READONLY_DATABASE_URL setup).
 *
 * It exercises: migrations, seeding, dataset import (schema + role creation, grants, RLS), querying as the dataset role
 * through the read-only login, isolation, deletion and TTL purge — everything the deployment guide relies on.
 * It does NOT prove anything about Supabase itself (pooler, PG version, platform-specific restrictions).
 */

const adminUrl = process.env.TEST_ADMIN_URL ?? "postgresql://postgres:postgres@127.0.0.1:54329/postgres";
const withDb = (url: string, db: string) => url.replace(/\/[^/?]*(\?|$)/, `/${db}$1`);
const DB = "nl2sql_managed_sim";
const OWNER = "nl2sql_sim_owner";
const OWNER_PW = "sim-owner-pw";
const READER_PW = "sim-reader-pw";

const raw = (sql: string) => sql as ValidatedSql;
const SESSION = "sess-managed-sim";

let pool: pg.Pool;
let company: Dataset;
let other: Dataset;

beforeAll(async () => {
  const su = new pg.Client({ connectionString: adminUrl });
  await su.connect();
  await su.query(`DROP DATABASE IF EXISTS ${DB} WITH (FORCE)`);
  await su.query(`DROP ROLE IF EXISTS ${OWNER}`);
  await su.query(`CREATE ROLE ${OWNER} LOGIN PASSWORD '${OWNER_PW}' CREATEROLE NOSUPERUSER NOCREATEDB NOBYPASSRLS`);
  await su.query(`CREATE DATABASE ${DB} OWNER ${OWNER}`);
  await su.end();

  // a superuser installs the extension into the `extensions` schema (managed platforms do this for you)
  const suDb = new pg.Client({ connectionString: withDb(adminUrl, DB) });
  await suDb.connect();
  await suDb.query("CREATE SCHEMA extensions");
  await suDb.query("CREATE EXTENSION vector WITH SCHEMA extensions");
  await suDb.query(`GRANT USAGE ON SCHEMA extensions TO ${OWNER}`);
  await suDb.end();
  const su2 = new pg.Client({ connectionString: adminUrl });
  await su2.connect();
  await su2.query(`ALTER ROLE ${OWNER} IN DATABASE ${DB} SET search_path = "$user", public, extensions`);
  await su2.end();

  const ownerUrl = withDb(adminUrl, DB).replace(/\/\/[^@]*@/, `//${OWNER}:${OWNER_PW}@`);
  process.env.DATABASE_URL = ownerUrl;
  delete process.env.READONLY_DATABASE_URL;

  const setup = new pg.Pool({ connectionString: ownerUrl, max: 2 });
  await migrate(setup);
  await seed(setup, new Date(), 0.05);
  // Roles are cluster-wide and `nl2sql_readonly` already exists on this test server (the other integration databases created it as a
  // superuser). On a fresh managed project the migration creates it as the owner, who then holds ADMIN OPTION on it — emulate that.
  const su3 = new pg.Client({ connectionString: adminUrl });
  await su3.connect();
  await su3.query(`GRANT nl2sql_readonly TO ${OWNER} WITH ADMIN OPTION`);
  await su3.end();
  // Supabase deployment guide, step 5: give the sandbox role its own login (done here by the non-superuser owner)
  await setup.query(`ALTER ROLE nl2sql_readonly LOGIN PASSWORD '${READER_PW}'`);
  await setup.end();

  process.env.READONLY_DATABASE_URL = ownerUrl.replace(`${OWNER}:${OWNER_PW}`, `nl2sql_readonly:${READER_PW}`);
  pool = getAdminPool();
}, 120_000);

afterAll(async () => {
  await closePools();
  const su = new pg.Client({ connectionString: adminUrl });
  await su.connect();
  await su.query(`DROP DATABASE IF EXISTS ${DB} WITH (FORCE)`);
  const stale = await su.query("SELECT rolname FROM pg_roles WHERE rolname LIKE 'nl2sql_ro_%'");
  // dataset roles are cluster-level: make sure a failed run does not leave them behind
  for (const r of stale.rows) await su.query(`DROP ROLE IF EXISTS "${r.rolname}"`).catch(() => undefined);
  // the shared role stays (other test databases use it) but must not keep this test's login
  await su.query("ALTER ROLE nl2sql_readonly NOLOGIN PASSWORD NULL").catch(() => undefined);
  await su.query(`REVOKE nl2sql_readonly FROM ${OWNER}`).catch(() => undefined);
  await su.query(`DROP ROLE IF EXISTS ${OWNER}`).catch(() => undefined);
  await su.end();
});

const deps = { pool: undefined as unknown as pg.Pool, sessionId: SESSION, clientHash: "client-managed-sim", limits: TEST_LIMITS };
const req = (text: string, name: string) => ({ name, files: [{ name: "data.sql", text }], generateDescriptions: false });

describe("managed-PostgreSQL permission model (non-superuser owner, extension in its own schema, read-only login)", () => {
  it("the owner role really is not a superuser and cannot bypass RLS", async () => {
    const r = await pool.query("SELECT rolsuper, rolbypassrls, rolcreaterole FROM pg_roles WHERE rolname = current_user");
    expect(r.rows[0]).toEqual({ rolsuper: false, rolbypassrls: false, rolcreaterole: true });
  });

  it("migrations and seeding work, and the vector type resolves from the extensions schema", async () => {
    const ext = await pool.query("SELECT n.nspname FROM pg_extension e JOIN pg_namespace n ON n.oid = e.extnamespace WHERE e.extname = 'vector'");
    expect(ext.rows[0].nspname).toBe("extensions");
    const emb = await pool.query("SELECT format_type(atttypid, atttypmod) AS t FROM pg_attribute WHERE attrelid = 'nl2sql.metadata_embeddings'::regclass AND attname = 'embedding'");
    expect(emb.rows[0].t).toBe("vector(768)");
    const orders = await pool.query("SELECT count(*)::int AS n FROM shop.orders");
    expect(orders.rows[0].n).toBeGreaterThan(100);
  });

  it("imports datasets (schema + role + grants + RLS) without superuser rights", async () => {
    deps.pool = pool;
    company = await importDataset(req(COMPANY_SQL, "Company"), deps);
    other = await importDataset(req(OTHER_SQL, "Other"), deps);
    expect(company.status).toBe("ready");
    expect(other.status).toBe("ready");
    const rls = await pool.query("SELECT c.relrowsecurity FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = $1 AND c.relname = 'employees'", [company.id]);
    expect(rls.rows[0].relrowsecurity).toBe(true);
  });

  it("answers queries through the dedicated read-only login (SET LOCAL ROLE to the dataset role)", async () => {
    const ctx = await loadDatasetContext(pool, company.id, SESSION);
    const res = await executeQuery({ sql: toValidatedSql(await validateSql("SELECT COUNT(*) AS n FROM employees", ctx)), dataset: ctx });
    expect(res.success && res.rows[0].n).toBe(5);
    const demo = getBuiltinContext();
    const d = await executeQuery({ sql: toValidatedSql(await validateSql("SELECT COUNT(*) AS n FROM orders", demo)), dataset: demo });
    expect(d.success && (d.rows[0].n as number)).toBeGreaterThan(100);
  });

  it("the read-only login itself has no direct access to anything (only via a dataset role it may SET ROLE to)", async () => {
    const reader = new pg.Client({ connectionString: process.env.READONLY_DATABASE_URL });
    await reader.connect();
    try {
      for (const sql of ["SELECT 1 FROM shop.orders LIMIT 1", "SELECT 1 FROM nl2sql.datasets LIMIT 1", `SELECT 1 FROM ${company.id}.employees LIMIT 1`]) {
        // shop is readable by nl2sql_readonly by design (it is the demo dataset's role); everything else must be refused
        const res = await reader.query(sql).then(() => "ok", (e: { code?: string }) => e.code);
        if (sql.includes("shop.")) expect(res, sql).toBe("ok");
        else expect(res, sql).toBe("42501");
      }
    } finally {
      await reader.end();
    }
  });

  it("isolation holds in this permission model: cross-dataset, app schema and demo reads are refused by the database", async () => {
    const a = await loadDatasetContext(pool, company.id, SESSION);
    const b = await loadDatasetContext(pool, other.id, SESSION);
    const demo = getBuiltinContext();
    const denied = async (sql: string, ctx: typeof a) => {
      const res = await runInSandbox({ sql: raw(sql), dataset: ctx });
      expect(res.success, sql).toBe(false);
      if (!res.success) expect(res.error.category).toBe("permission");
    };
    await denied(`SELECT * FROM ${other.id}.employees`, a);
    await denied(`SELECT * FROM ${company.id}.employees`, b);
    await denied("SELECT * FROM shop.orders", a);
    await denied("SELECT * FROM nl2sql.query_runs", a);
    await denied(`SELECT * FROM ${company.id}.employees`, demo);
    const write = await runInSandbox({ sql: raw("DELETE FROM employees"), dataset: a });
    expect(write.success).toBe(false);
  });

  it("deleting a dataset drops its schema and its cluster-level role; the TTL purge does the same", async () => {
    const role = `nl2sql_ro_${other.id.slice(3)}`;
    await deleteDataset(pool, other.id);
    expect((await pool.query("SELECT 1 FROM pg_roles WHERE rolname = $1", [role])).rowCount).toBe(0);
    expect((await pool.query("SELECT 1 FROM pg_namespace WHERE nspname = $1", [other.id])).rowCount).toBe(0);

    await pool.query("UPDATE nl2sql.datasets SET created_at = now() - interval '100 hours' WHERE id = $1", [company.id]);
    const purged = await purgeExpiredDatasets(pool, TEST_LIMITS);
    expect(purged).toBeGreaterThanOrEqual(1);
    expect((await pool.query("SELECT 1 FROM pg_namespace WHERE nspname = $1", [company.id])).rowCount).toBe(0);
    expect((await pool.query("SELECT 1 FROM pg_roles WHERE rolname = $1", [`nl2sql_ro_${company.id.slice(3)}`])).rowCount).toBe(0);
  });
});
