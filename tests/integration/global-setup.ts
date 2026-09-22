import pg from "pg";
import { migrate, seed } from "../../scripts/db";

/**
 * Creates a fresh `nl2sql_test` database on the server given by TEST_ADMIN_URL (default: the local docker
 * container from docs), migrates it and seeds a small deterministic dataset (anchored at today, so relative dates like "last month" have data).
 * Sets DATABASE_URL for the test workers.
 */
export default async function setup() {
  const adminUrl = process.env.TEST_ADMIN_URL ?? "postgresql://postgres:postgres@127.0.0.1:54329/postgres";
  const admin = new pg.Client({ connectionString: adminUrl });
  try {
    await admin.connect();
  } catch (err) {
    throw new Error(
      `Integration tests need a PostgreSQL server with pgvector (see README → Testing). Could not connect to ${adminUrl.replace(/:[^:@/]*@/, ":***@")}: ${(err as Error).message}`,
    );
  }
  await admin.query("DROP DATABASE IF EXISTS nl2sql_test WITH (FORCE)");
  await admin.query("CREATE DATABASE nl2sql_test");
  await admin.end();

  const testUrl = adminUrl.replace(/\/[^/?]*(\?|$)/, "/nl2sql_test$1");
  process.env.DATABASE_URL = testUrl;
  delete process.env.READONLY_DATABASE_URL;

  const pool = new pg.Pool({ connectionString: testUrl, max: 2 });
  try {
    await migrate(pool);
    await seed(pool, new Date(), 0.35);
  } finally {
    await pool.end();
  }
}
