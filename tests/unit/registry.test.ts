import { describe, expect, it } from "vitest";
import { buildMetadataItems, getColumn, getTable, registry, shortestJoinPath, TABLE_NAMES } from "@/lib/metadata/registry";
import { validateSql } from "@/lib/database/validator";

describe("metadata registry", () => {
  it("describes 20 tables", () => {
    expect(registry.tables).toHaveLength(20);
    expect(new Set(TABLE_NAMES).size).toBe(20);
  });

  it("gives every table and column a description", () => {
    for (const t of registry.tables) {
      expect(t.description.length, t.name).toBeGreaterThan(10);
      expect(t.primaryKey.length, t.name).toBeGreaterThan(0);
      for (const c of t.columns) expect(c.description.length, `${t.name}.${c.name}`).toBeGreaterThan(3);
    }
  });

  it("only references tables and columns that exist", () => {
    for (const r of registry.relationships) {
      expect(getColumn(r.fromTable, r.fromColumn), `${r.fromTable}.${r.fromColumn}`).toBeDefined();
      expect(getColumn(r.toTable, r.toColumn), `${r.toTable}.${r.toColumn}`).toBeDefined();
    }
    for (const m of registry.metrics) {
      for (const t of m.tables) expect(getTable(t), `${m.name} → ${t}`).toBeDefined();
      for (const c of m.columns) expect(getColumn(c.table, c.column), `${m.name} → ${c.table}.${c.column}`).toBeDefined();
    }
    for (const t of registry.tables) for (const pk of t.primaryKey) expect(getColumn(t.name, pk), `${t.name}.${pk}`).toBeDefined();
  });

  it("derives relationships from foreign-key columns", () => {
    expect(registry.relationships.length).toBeGreaterThanOrEqual(25);
    expect(registry.relationships).toContainEqual(expect.objectContaining({ fromTable: "orders", fromColumn: "customer_id", toTable: "customers", toColumn: "customer_id" }));
  });

  it("builds one retrievable item per table, column and metric", () => {
    const items = buildMetadataItems();
    const cols = registry.tables.reduce((n, t) => n + t.columns.length, 0);
    expect(items).toHaveLength(registry.tables.length + cols + registry.metrics.length);
    expect(new Set(items.map((i) => i.id)).size).toBe(items.length);
  });

  it("finds join paths through the FK graph", () => {
    expect(shortestJoinPath("product_categories", "orders")).toEqual(["product_categories", "products", "order_items", "orders"]);
    expect(shortestJoinPath("orders", "orders")).toEqual(["orders"]);
  });

  it("metric definitions reference only valid tables (definition text mentions real columns)", async () => {
    // Sanity: each metric's declared columns must be accepted by the validator when used in a trivial query.
    for (const m of registry.metrics) {
      for (const c of m.columns) {
        const res = await validateSql(`SELECT t.${c.column} FROM ${c.table} t`);
        expect(res.valid, `${m.name}: ${c.table}.${c.column}`).toBe(true);
      }
    }
  });
});
