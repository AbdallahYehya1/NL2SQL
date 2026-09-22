import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { pointAtTestDatabase, testDatabaseUrl } from "../helpers/db";
import { resetConfigCache } from "@/lib/config";
import { closePools } from "@/lib/database/client";
import { executeQuery, runInSandbox } from "@/lib/database/executor";
import { toValidatedSql, validateSql } from "@/lib/database/validator";
import type { ValidatedSql } from "@/lib/types";

pointAtTestDatabase();

/** Bypass the validator on purpose to prove the DATABASE layer also refuses dangerous statements. */
const raw = (sql: string) => sql as ValidatedSql;
const validated = async (sql: string) => toValidatedSql(await validateSql(sql));

let admin: pg.Pool;
beforeAll(() => {
  admin = new pg.Pool({ connectionString: testDatabaseUrl(), max: 2 });
});
afterAll(async () => {
  await admin.end();
  await closePools();
});

describe("executeQuery — normal operation", () => {
  it("returns columns, rows, rowCount and timing", async () => {
    const res = await executeQuery({ sql: await validated("SELECT status, COUNT(*) AS n FROM orders GROUP BY status ORDER BY n DESC") });
    expect(res.success).toBe(true);
    if (!res.success) return;
    expect(res.columns).toEqual(["status", "n"]);
    expect(res.rowCount).toBe(res.rows.length);
    expect(typeof res.rows[0].n).toBe("number"); // bigint → number
    expect(res.executionTimeMs).toBeGreaterThanOrEqual(0);
    expect(res.truncated).toBe(false);
  });

  it("caps result size and flags truncation", async () => {
    const res = await executeQuery({ sql: await validated("SELECT order_id FROM orders ORDER BY order_id"), maxRows: 7 });
    expect(res.success).toBe(true);
    if (res.success) {
      expect(res.rows).toHaveLength(7);
      expect(res.truncated).toBe(true);
    }
  });

  it("serialises dates and numerics to JSON-friendly values", async () => {
    const res = await executeQuery({ sql: await validated("SELECT date_trunc('month', order_date) AS m, ROUND(SUM(total_amount), 2) AS revenue FROM orders GROUP BY 1 ORDER BY 1 LIMIT 1") });
    expect(res.success).toBe(true);
    if (res.success) {
      expect(typeof res.rows[0].m).toBe("string");
      expect(typeof res.rows[0].revenue).toBe("number");
      expect(() => JSON.stringify(res.rows)).not.toThrow();
    }
  });

  it("resolves unqualified tables through the pinned search_path", async () => {
    const res = await executeQuery({ sql: await validated("SELECT COUNT(*) AS n FROM customers") });
    expect(res.success).toBe(true);
  });
});

describe("executeQuery — errors are classified and sanitised", () => {
  it("classifies missing columns", async () => {
    const res = await runInSandbox({ sql: raw("SELECT nonexistent FROM customers") });
    expect(res.success).toBe(false);
    if (!res.success) {
      expect(res.error.code).toBe("42703");
      expect(res.error.category).toBe("undefined_column");
      expect(res.error.detail).toContain("nonexistent");
      expect(res.error.message).not.toContain("nonexistent"); // user message stays generic
    }
  });

  it("classifies syntax errors and missing tables", async () => {
    const syn = await runInSandbox({ sql: raw("SELECT FROM WHERE") });
    const tbl = await runInSandbox({ sql: raw("SELECT * FROM no_such_table") });
    expect(!syn.success && syn.error.category).toBe("syntax");
    expect(!tbl.success && tbl.error.category).toBe("undefined_table");
  });

  it("classifies data exceptions", async () => {
    const res = await runInSandbox({ sql: raw("SELECT 1 / 0") });
    expect(!res.success && res.error.category).toBe("data_exception");
  });

  it("enforces the statement timeout", async () => {
    const started = Date.now();
    const res = await runInSandbox({ sql: raw("SELECT pg_sleep(5)"), timeoutMs: 500 });
    expect(res.success).toBe(false);
    if (!res.success) {
      expect(res.error.category).toBe("timeout");
      expect(res.error.message).toContain("too long");
    }
    expect(Date.now() - started).toBeLessThan(3000);
  });
});

describe("executeQuery refuses forged / unsafe SQL itself", () => {
  it("re-validates even when the brand is forged", async () => {
    for (const sql of ["DELETE FROM customers", "SELECT 1; RESET ROLE", "SELECT pg_sleep(1)", "SELECT * FROM nl2sql.query_runs"]) {
      const res = await executeQuery({ sql: raw(sql) });
      expect(res.success, sql).toBe(false);
      if (!res.success) expect(res.error.code).toBe("VALIDATION_FAILED");
    }
  });
});

describe("defence in depth — the database refuses writes even if validation were bypassed", () => {
  const dataCount = async () => (await admin.query("SELECT count(*)::int AS n FROM shop.customers")).rows[0].n as number;

  for (const sql of [
    "DELETE FROM customers",
    "UPDATE customers SET email = 'x'",
    "INSERT INTO customers (first_name, last_name, email, signup_date, segment, acquisition_channel) VALUES ('a','b','c','2020-01-01','standard','organic')",
    "TRUNCATE customers",
    "DROP TABLE customers",
    "CREATE TABLE shop.evil (id int)",
  ]) {
    it(`refuses: ${sql.slice(0, 40)}`, async () => {
      const before = await dataCount();
      const res = await runInSandbox({ sql: raw(sql) });
      expect(res.success).toBe(false);
      expect(await dataCount()).toBe(before);
      const exists = await admin.query("SELECT to_regclass('shop.customers') AS t, to_regclass('shop.evil') AS e");
      expect(exists.rows[0].t).not.toBeNull();
      expect(exists.rows[0].e).toBeNull();
    });
  }

  it("cannot read the application schema (history, embeddings)", async () => {
    const res = await runInSandbox({ sql: raw("SELECT * FROM nl2sql.query_runs") });
    expect(res.success).toBe(false);
    if (!res.success) expect(res.error.category).toBe("permission");
  });

  it("rolls back: no side effects persist between calls", async () => {
    await runInSandbox({ sql: raw("SELECT nextval('shop.customers_customer_id_seq')") });
    const seq = await admin.query("SELECT last_value FROM shop.customers_customer_id_seq");
    const max = await admin.query("SELECT max(customer_id) AS m FROM shop.customers");
    expect(Number(seq.rows[0].last_value)).toBe(Number(max.rows[0].m));
  });
});

describe("dedicated read-only login (READONLY_DATABASE_URL)", () => {
  it("works when the read-only role logs in directly", async () => {
    await admin.query("ALTER ROLE nl2sql_readonly LOGIN PASSWORD 'ro_test_pw'");
    try {
      const url = new URL(testDatabaseUrl());
      url.username = "nl2sql_readonly";
      url.password = "ro_test_pw";
      process.env.READONLY_DATABASE_URL = url.toString();
      resetConfigCache();
      await closePools();
      const ok = await executeQuery({ sql: await validated("SELECT COUNT(*) AS n FROM orders") });
      expect(ok.success).toBe(true);
      const bad = await runInSandbox({ sql: raw("DELETE FROM customers") });
      expect(bad.success).toBe(false);
      const noApp = await runInSandbox({ sql: raw("SELECT * FROM nl2sql.metadata_embeddings") });
      expect(noApp.success).toBe(false);
    } finally {
      delete process.env.READONLY_DATABASE_URL;
      resetConfigCache();
      await closePools();
      await admin.query("ALTER ROLE nl2sql_readonly NOLOGIN");
    }
  });
});
