import { describe, expect, it } from "vitest";
import { validateSql } from "@/lib/database/validator";
import { UNSAFE_SQL } from "../evaluation/unsafe-sql";

describe("SQL validator — accepts legitimate read-only queries", () => {
  const good: [string, string][] = [
    ["simple select", "SELECT customer_id, first_name FROM customers LIMIT 10"],
    ["schema-qualified", "SELECT * FROM shop.customers"],
    ["trailing semicolon", "SELECT COUNT(*) FROM orders;"],
    ["join + group + order", "SELECT c.name, SUM(oi.line_total) AS revenue FROM order_items oi JOIN orders o ON o.order_id = oi.order_id JOIN products p ON p.product_id = oi.product_id JOIN product_categories c ON c.category_id = p.category_id WHERE o.status IN ('shipped','delivered') GROUP BY c.name ORDER BY revenue DESC LIMIT 5"],
    ["CTE", "WITH m AS (SELECT date_trunc('month', order_date) AS month, SUM(total_amount) AS rev FROM orders GROUP BY 1) SELECT month, rev FROM m ORDER BY month"],
    ["window function", "SELECT o.order_id, ROW_NUMBER() OVER (PARTITION BY o.customer_id ORDER BY o.order_date) AS rn FROM orders o"],
    ["extract + interval", "SELECT EXTRACT(month FROM o.order_date) AS m, COUNT(*) FROM orders o WHERE o.order_date >= CURRENT_DATE - INTERVAL '6 months' GROUP BY 1"],
    ["filter aggregate", "SELECT SUM(oi.line_total) FILTER (WHERE oi.quantity > 1) FROM order_items oi"],
    ["FETCH FIRST", "SELECT name FROM products ORDER BY unit_price DESC FETCH FIRST 5 ROWS ONLY"],
    ["subquery + NOT EXISTS", "SELECT p.name FROM products p WHERE NOT EXISTS (SELECT 1 FROM order_items oi WHERE oi.product_id = p.product_id)"],
    ["coalesce/nullif/round", "SELECT ROUND(100.0 * COUNT(*) / NULLIF((SELECT COUNT(*) FROM orders), 0), 2) FROM refunds"],
    ["string literal containing keyword", "SELECT * FROM products WHERE name ILIKE '%update%' OR description ILIKE '%delete%'"],
    ["column with keyword-like name", "SELECT created_at FROM products LIMIT 1"],
    ["select alias in order by", "SELECT status, COUNT(*) AS n FROM orders GROUP BY status ORDER BY n DESC"],
    ["values string with double dash", "SELECT 1"],
  ];
  for (const [name, sql] of good) {
    it(name, async () => {
      const res = await validateSql(sql);
      expect(res.issues).toEqual([]);
      expect(res.valid).toBe(true);
      expect(res.sql).toBeTruthy();
    });
  }

  it("reports tables and columns used", async () => {
    const res = await validateSql("SELECT c.name, o.order_date FROM orders o JOIN order_items oi ON oi.order_id = o.order_id JOIN products p ON p.product_id = oi.product_id JOIN product_categories c ON c.category_id = p.category_id");
    expect(res.valid).toBe(true);
    expect(res.tablesUsed).toEqual(["order_items", "orders", "product_categories", "products"]);
    expect(res.columnsUsed).toContain("orders.order_date");
    expect(res.columnsUsed).toContain("product_categories.name");
  });

  it("strips a trailing semicolon from the executable SQL", async () => {
    const res = await validateSql("SELECT 1 FROM orders;");
    expect(res.sql).toBe("SELECT 1 FROM orders");
  });

  it("does not treat CTE names as unknown tables", async () => {
    const res = await validateSql("WITH recent AS (SELECT * FROM orders) SELECT COUNT(*) FROM recent");
    expect(res.valid).toBe(true);
    expect(res.tablesUsed).toEqual(["orders"]);
  });
});

describe("SQL validator — rejects unsafe SQL", () => {
  for (const { name, sql } of UNSAFE_SQL) {
    it(`blocks: ${name}`, async () => {
      const res = await validateSql(sql);
      expect(res.valid, `should have been rejected: ${sql}`).toBe(false);
      expect(res.issues.length).toBeGreaterThan(0);
      expect(res.sql).toBeUndefined();
    });
  }

  it("uses specific error codes", async () => {
    expect((await validateSql("DROP TABLE products")).issues[0].code).toBe("WRITE_OPERATION");
    expect((await validateSql("SELECT 1; SELECT 2")).issues[0].code).toBe("MULTIPLE_STATEMENTS");
    expect((await validateSql("SELECT 1 -- x")).issues[0].code).toBe("COMMENT_NOT_ALLOWED");
    expect((await validateSql("SELECT pg_sleep(1)")).issues[0].code).toBe("FORBIDDEN_FUNCTION");
    expect((await validateSql("SELECT * FROM pg_shadow")).issues[0].code).toBe("SYSTEM_ACCESS");
    expect((await validateSql("SELECT * FROM public.customers")).issues[0].code).toBe("FORBIDDEN_SCHEMA");
    expect((await validateSql("SELECT * FROM nope")).issues[0].code).toBe("UNKNOWN_TABLE");
    expect((await validateSql("SELECT o.bogus FROM orders o")).issues[0].code).toBe("UNKNOWN_COLUMN");
    expect((await validateSql("SELECT * FROM customers FOR UPDATE")).issues.map((i) => i.code)).toContain("WRITE_OPERATION");
    expect((await validateSql("SELECT * FROM (SELECT 1) x WHERE")).issues[0].code).toBe("PARSE_ERROR");
  });

  it("explains what is available when a table is hallucinated", async () => {
    const res = await validateSql("SELECT * FROM sales_summary");
    expect(res.issues[0].message).toContain("orders");
  });

  it("rejects oversized SQL", async () => {
    const res = await validateSql(`SELECT ${"1, ".repeat(2500)}1 FROM orders`);
    expect(res.issues[0].code).toBe("TOO_LONG");
  });

  it("rejects unsupported column on an aliased table but allows select aliases", async () => {
    expect((await validateSql("SELECT o.total FROM orders o")).valid).toBe(false);
    expect((await validateSql("SELECT total_amount AS total FROM orders ORDER BY total")).valid).toBe(true);
  });
});
