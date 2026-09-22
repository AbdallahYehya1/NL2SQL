/**
 * Database management CLI (works against any PostgreSQL, including Supabase).
 *
 *   npm run db:migrate   apply pending SQL files from supabase/migrations
 *   npm run db:seed      (re)generate and load the deterministic demo data
 *   npm run db:reset     drop schemas shop + nl2sql + every uploaded dataset (ds_*), re-run migrations, re-seed
 *   npm run db:status    show applied migrations and row counts
 *
 * Reads DATABASE_URL from .env.local / .env / the environment. Optional: SEED_ANCHOR_DATE=YYYY-MM-DD
 * (last day of generated data; defaults to today so "last month" questions have data).
 */
import { config as loadEnv } from "dotenv";
import fs from "node:fs";
import path from "node:path";
import type pg from "pg";
import { generateDataset, TABLE_LOAD_ORDER, type Row } from "../supabase/seed/generate";
import { closePools, getAdminPool } from "../src/lib/database/client";

loadEnv({ path: ".env.local" });
loadEnv({ path: ".env" });

const MIGRATIONS_DIR = path.resolve(process.cwd(), "supabase/migrations");
const TRACKING_TABLE = "nl2sql.schema_migrations";

async function ensureTracking(client: pg.PoolClient) {
  await client.query("CREATE SCHEMA IF NOT EXISTS nl2sql");
  await client.query(`CREATE TABLE IF NOT EXISTS ${TRACKING_TABLE} (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`);
}

export async function migrate(pool: pg.Pool): Promise<string[]> {
  const files = fs.readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith(".sql")).sort();
  const applied: string[] = [];
  const client = await pool.connect();
  try {
    await ensureTracking(client);
    const done = new Set((await client.query(`SELECT name FROM ${TRACKING_TABLE}`)).rows.map((r) => r.name as string));
    for (const file of files) {
      if (done.has(file)) continue;
      const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, file), "utf8");
      await client.query("BEGIN");
      try {
        await client.query(sql);
        await client.query(`INSERT INTO ${TRACKING_TABLE} (name) VALUES ($1)`, [file]);
        await client.query("COMMIT");
        applied.push(file);
        console.log(`  applied ${file}`);
      } catch (err) {
        await client.query("ROLLBACK");
        throw new Error(`Migration ${file} failed: ${(err as Error).message}`);
      }
    }
  } finally {
    client.release();
  }
  return applied;
}

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

export async function seed(pool: pg.Pool, anchor?: Date, scale = 1): Promise<Record<string, number>> {
  const dataset = generateDataset({ anchorDate: anchor, scale });
  const client = await pool.connect();
  const counts: Record<string, number> = {};
  try {
    await client.query("BEGIN");
    await client.query(`TRUNCATE ${TABLE_LOAD_ORDER.map((t) => `shop.${t}`).join(", ")} RESTART IDENTITY CASCADE`);
    for (const table of TABLE_LOAD_ORDER) {
      const rows: Row[] = dataset[table] ?? [];
      counts[table] = rows.length;
      if (!rows.length) continue;
      const columns = Object.keys(rows[0]);
      const perChunk = Math.max(1, Math.floor(60000 / columns.length));
      for (const part of chunk(rows, perChunk)) {
        const params: unknown[] = [];
        const tuples = part.map((row) => `(${columns.map((c) => `$${params.push(row[c])}`).join(",")})`);
        await client.query(`INSERT INTO shop.${table} (${columns.join(",")}) OVERRIDING SYSTEM VALUE VALUES ${tuples.join(",")}`, params);
      }
      // keep identity sequences ahead of explicitly inserted ids
      const idCol = columns[0];
      const seq = await client.query(`SELECT pg_get_serial_sequence('shop.${table}', '${idCol}') AS seq`);
      if (seq.rows[0]?.seq) await client.query(`SELECT setval($1, (SELECT COALESCE(MAX(${idCol}), 1) FROM shop.${table}))`, [seq.rows[0].seq]);
    }
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
  await pool.query("ANALYZE");
  return counts;
}

export async function resetSchemas(pool: pg.Pool) {
  // uploaded datasets: one schema (ds_<hex>) and one read-only role (nl2sql_ro_<hex>) each
  const schemas = (await pool.query("SELECT nspname FROM pg_namespace WHERE starts_with(nspname, 'ds_')")).rows.map((r) => r.nspname as string);
  const roles = (await pool.query("SELECT rolname FROM pg_roles WHERE starts_with(rolname, 'nl2sql_ro_')")).rows.map((r) => r.rolname as string);
  for (const schema of schemas) await pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
  for (const role of roles) {
    await pool.query(`REVOKE "${role}" FROM nl2sql_readonly`).catch(() => undefined);
    await pool.query(`DROP OWNED BY "${role}"`).catch(() => undefined);
    await pool.query(`DROP ROLE IF EXISTS "${role}"`).catch(() => undefined);
  }
  await pool.query("DROP SCHEMA IF EXISTS shop CASCADE");
  await pool.query("DROP SCHEMA IF EXISTS nl2sql CASCADE");
}

function anchorFromEnv(): Date | undefined {
  const v = process.env.SEED_ANCHOR_DATE;
  if (!v) return undefined;
  const d = new Date(`${v}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) throw new Error(`Invalid SEED_ANCHOR_DATE: ${v}`);
  return d;
}

async function main() {
  const cmd = process.argv[2];
  if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is not set (see .env.example).");
  const pool = getAdminPool();
  try {
    switch (cmd) {
      case "migrate": {
        console.log("Applying migrations…");
        const applied = await migrate(pool);
        console.log(applied.length ? `Done (${applied.length} applied).` : "Nothing to apply — schema is up to date.");
        break;
      }
      case "seed": {
        console.log("Seeding demo data…");
        const counts = await seed(pool, anchorFromEnv());
        console.table(counts);
        break;
      }
      case "reset": {
        console.log("Dropping schemas shop and nl2sql…");
        await resetSchemas(pool);
        console.log("Applying migrations…");
        await migrate(pool);
        console.log("Seeding demo data…");
        console.table(await seed(pool, anchorFromEnv()));
        break;
      }
      case "status": {
        const applied = await pool.query(`SELECT name, applied_at FROM ${TRACKING_TABLE} ORDER BY name`).catch(() => ({ rows: [] }));
        console.log("Applied migrations:", applied.rows.map((r) => r.name));
        const counts: Record<string, number> = {};
        for (const t of TABLE_LOAD_ORDER) counts[t] = (await pool.query(`SELECT count(*)::int AS n FROM shop.${t}`).catch(() => ({ rows: [{ n: -1 }] }))).rows[0].n;
        console.table(counts);
        break;
      }
      default:
        console.log("Usage: tsx scripts/db.ts <migrate|seed|reset|status>");
        process.exitCode = 1;
    }
  } finally {
    await closePools();
  }
}

// Run only when executed directly (tests import migrate/seed/resetSchemas).
if (process.argv[1] && path.basename(process.argv[1]).startsWith("db.")) {
  main().catch((err) => {
    console.error(err.message ?? err);
    process.exit(1);
  });
}
