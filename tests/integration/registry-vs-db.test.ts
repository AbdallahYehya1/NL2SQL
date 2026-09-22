import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { registry } from "@/lib/metadata/registry";
import { testDatabaseUrl } from "../helpers/db";

/** The registry is hand-written metadata; this proves it matches the real database. */
let pool: pg.Pool;
beforeAll(() => {
  pool = new pg.Pool({ connectionString: testDatabaseUrl(), max: 2 });
});
afterAll(async () => {
  await pool.end();
});

const normType = (t: string) => {
  const base = t.replace(/\(.*\)/, "").trim();
  return { "timestamp with time zone": "timestamptz", "double precision": "double" }[base] ?? base;
};

describe("registry ↔ database", () => {
  it("has exactly the same tables", async () => {
    const res = await pool.query("SELECT table_name FROM information_schema.tables WHERE table_schema = 'shop' AND table_type = 'BASE TABLE'");
    expect(res.rows.map((r) => r.table_name).sort()).toEqual(registry.tables.map((t) => t.name).sort());
  });

  it("has the same columns and types for every table", async () => {
    const res = await pool.query("SELECT table_name, column_name, data_type, numeric_precision, numeric_scale FROM information_schema.columns WHERE table_schema = 'shop'");
    const byTable = new Map<string, Map<string, string>>();
    for (const r of res.rows) {
      if (!byTable.has(r.table_name)) byTable.set(r.table_name, new Map());
      byTable.get(r.table_name)!.set(r.column_name, r.data_type);
    }
    for (const t of registry.tables) {
      const actual = byTable.get(t.name)!;
      expect([...actual.keys()].sort(), t.name).toEqual(t.columns.map((c) => c.name).sort());
      for (const c of t.columns) {
        const dbType = normType(actual.get(c.name)!);
        const regType = normType(c.type);
        expect(dbType === regType || (regType === "timestamptz" && dbType === "timestamptz"), `${t.name}.${c.name}: registry ${c.type} vs db ${actual.get(c.name)}`).toBe(true);
      }
    }
  });

  it("declares exactly the foreign keys that exist", async () => {
    const res = await pool.query(`
      SELECT tc.table_name, kcu.column_name, ccu.table_name AS ref_table, ccu.column_name AS ref_column
        FROM information_schema.table_constraints tc
        JOIN information_schema.key_column_usage kcu ON tc.constraint_name = kcu.constraint_name AND tc.table_schema = kcu.table_schema
        JOIN information_schema.constraint_column_usage ccu ON ccu.constraint_name = tc.constraint_name AND ccu.table_schema = tc.table_schema
       WHERE tc.constraint_type = 'FOREIGN KEY' AND tc.table_schema = 'shop'`);
    const db = res.rows.map((r) => `${r.table_name}.${r.column_name}->${r.ref_table}.${r.ref_column}`).sort();
    const reg = registry.relationships.map((r) => `${r.fromTable}.${r.fromColumn}->${r.toTable}.${r.toColumn}`).sort();
    expect(reg).toEqual(db);
  });

  it("declares the real primary keys", async () => {
    const res = await pool.query(`
      SELECT tc.table_name, array_agg(kcu.column_name::text ORDER BY kcu.ordinal_position) AS cols
        FROM information_schema.table_constraints tc
        JOIN information_schema.key_column_usage kcu ON tc.constraint_name = kcu.constraint_name AND tc.table_schema = kcu.table_schema
       WHERE tc.constraint_type = 'PRIMARY KEY' AND tc.table_schema = 'shop' GROUP BY tc.table_name`);
    const db = new Map(res.rows.map((r) => [r.table_name as string, r.cols as string[]]));
    for (const t of registry.tables) expect([...t.primaryKey].sort(), t.name).toEqual([...(db.get(t.name) ?? [])].sort());
  });

  it("lists sample values that actually occur in the data (enumerated columns)", async () => {
    for (const t of registry.tables) {
      for (const c of t.columns) {
        if (!c.sampleValues?.length || c.type.startsWith("integer") || t.name === "promotions") continue;
        // The registry examples for name-like columns are illustrative; only check low-cardinality enum-like columns.
        if (!["status", "payment_method", "reason", "movement_type", "segment", "acquisition_channel", "store_type", "discount_type", "address_type", "carrier"].includes(c.name)) continue;
        const res = await pool.query(`SELECT DISTINCT ${c.name}::text AS v FROM shop.${t.name}`);
        const actual = new Set(res.rows.map((r) => r.v));
        for (const v of c.sampleValues) expect(actual.has(v), `${t.name}.${c.name} sample "${v}"`).toBe(true);
      }
    }
  });

  it("has enough seed data for analytics, spanning at least two years", async () => {
    const counts = await pool.query(`SELECT (SELECT count(*) FROM shop.orders)::int orders, (SELECT count(*) FROM shop.order_items)::int items,
        (SELECT count(*) FROM shop.customers)::int customers, (SELECT count(*) FROM shop.products)::int products,
        (SELECT count(*) FROM shop.refunds)::int refunds, (SELECT count(*) FROM shop.store_sales)::int store_sales,
        (SELECT count(*) FROM shop.reviews)::int reviews, (SELECT extract(days FROM max(order_date) - min(order_date))::int FROM shop.orders) span_days`);
    const r = counts.rows[0];
    expect(r.orders).toBeGreaterThan(2000);
    expect(r.items).toBeGreaterThan(r.orders);
    expect(r.customers).toBeGreaterThan(500);
    expect(r.products).toBeGreaterThan(50);
    expect(r.refunds).toBeGreaterThan(20);
    expect(r.store_sales).toBeGreaterThan(2000);
    expect(r.reviews).toBeGreaterThan(200);
    expect(r.span_days).toBeGreaterThan(700);
  });

  it("keeps orders.total_amount consistent with its line items", async () => {
    const res = await pool.query(`SELECT count(*)::int AS bad FROM shop.orders o
       JOIN (SELECT order_id, sum(line_total) AS s FROM shop.order_items GROUP BY order_id) x USING (order_id)
      WHERE abs(o.total_amount - x.s) > 0.01`);
    expect(res.rows[0].bad).toBe(0);
  });
});
