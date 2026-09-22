import { describe, expect, it } from "vitest";
import { retrieveMetadata } from "@/lib/nl2sql/metadata-retriever";
import { route } from "@/lib/nl2sql/router";
import { buildSubSchema } from "@/lib/nl2sql/sub-schema-builder";
import { renderSubSchema } from "@/lib/ai/prompts/common";
import { getTable } from "@/lib/metadata/registry";
import { BENCHMARK } from "../evaluation/benchmark";

async function routeQuestion(q: string) {
  const retrieval = await retrieveMetadata(q);
  const routing = route(retrieval.items, retrieval.method, retrieval.vectorUnavailableReason);
  return { retrieval, routing, subSchema: buildSubSchema(routing) };
}

describe("metadata retrieval (lexical fallback)", () => {
  it("reports why vector search is not used", async () => {
    const r = await retrieveMetadata("top products by revenue");
    expect(r.method).toBe("lexical");
    expect(r.vectorUnavailableReason).toBeTruthy();
  });

  it("scores the metric and tables relevant to the question highest", async () => {
    const r = await retrieveMetadata("What percentage of orders were refunded?");
    expect(r.items.find((i) => i.kind === "metric")?.metric).toBe("refund_rate");
    expect(r.items.some((i) => i.id === "table:refunds")).toBe(true);
  });

  it("matches synonyms and plurals (vendors → suppliers, cities → city)", async () => {
    expect((await routeQuestion("Which vendors have the most products?")).routing.selectedTables).toContain("suppliers");
    expect((await routeQuestion("orders per city")).routing.selectedTables).toContain("customer_addresses");
  });

  it("returns nothing for unrelated text", async () => {
    const r = await retrieveMetadata("qwertyuiop asdfghjkl");
    expect(r.items).toHaveLength(0);
    expect(route(r.items).selectedTables).toHaveLength(0);
  });
});

describe("semantic routing + relationship expansion", () => {
  it("routes category revenue to categories, products (bridge), order_items and orders", async () => {
    const { routing } = await routeQuestion("What were the top 5 product categories by revenue last month?");
    const all = new Set([...routing.selectedTables, ...routing.bridgeTables]);
    for (const t of ["product_categories", "products", "order_items", "orders"]) expect(all.has(t), t).toBe(true);
    expect(routing.matchedMetrics).toContain("revenue");
  });

  it("does not send the whole schema to the model", async () => {
    for (const q of ["Which products have low inventory?", "What was the average order value last month?", "How many customers made more than 3 purchases?"]) {
      const { subSchema } = await routeQuestion(q);
      expect(subSchema.tables.length, q).toBeLessThanOrEqual(6);
    }
  });

  it("connects selected tables through valid foreign keys only", async () => {
    const { subSchema } = await routeQuestion("Which brand generates the most revenue?");
    const names = new Set(subSchema.tables.map((t) => t.name));
    for (const r of subSchema.relationships) {
      expect(names.has(r.fromTable) && names.has(r.toTable)).toBe(true);
    }
    expect(subSchema.relationships.length).toBeGreaterThan(0);
  });

  it("uses the documented default: revenue means online orders, not store_sales", async () => {
    const { routing } = await routeQuestion("What is the total revenue by country?");
    expect(routing.selectedTables).not.toContain("store_sales");
    const store = await routeQuestion("Which store had the highest in-store sales?");
    expect(store.routing.selectedTables).toContain("store_sales");
  });
});

describe("sub-schema builder", () => {
  it("includes key columns, matched-metric columns and business definitions", async () => {
    const { subSchema } = await routeQuestion("What was the average order value last month?");
    const orders = subSchema.tables.find((t) => t.name === "orders")!;
    const cols = orders.columns.map((c) => c.name);
    expect(cols).toEqual(expect.arrayContaining(["order_id", "order_date", "status", "total_amount"]));
    expect(subSchema.metrics.map((m) => m.name)).toContain("average_order_value");
    expect(subSchema.defaults.some((d) => d.name === "relative_dates")).toBe(true);
  });

  it("omits irrelevant columns of selected tables", async () => {
    const { subSchema } = await routeQuestion("Which products have low inventory?");
    const products = subSchema.tables.find((t) => t.name === "products")!;
    expect(products.columns.map((c) => c.name)).not.toContain("weight_kg");
    expect(products.columns.length).toBeLessThan(getTable("products")!.columns.length);
  });

  it("keeps bridge tables to join keys only", async () => {
    const { subSchema } = await routeQuestion("What were the top 5 product categories by revenue last month?");
    const bridge = subSchema.tables.find((t) => t.bridgeOnly);
    if (bridge) expect(bridge.columns.length).toBeLessThan(getTable(bridge.name)!.columns.length);
  });

  it("renders a compact prompt-ready description", async () => {
    const { subSchema } = await routeQuestion("Which supplier provides the most products?");
    const text = renderSubSchema(subSchema);
    expect(text).toContain("TABLE suppliers");
    expect(text).toContain("JOIN RELATIONSHIPS");
    expect(text).not.toContain("TABLE payments");
  });
});

describe("routing accuracy on the benchmark (lexical only, no LLM)", () => {
  it("selects every table needed for at least 85% of benchmark questions", async () => {
    let hits = 0;
    const misses: string[] = [];
    for (const c of BENCHMARK) {
      const { routing } = await routeQuestion(c.question);
      const got = new Set([...routing.selectedTables, ...routing.bridgeTables]);
      if (c.expectedTables.every((t) => got.has(t))) hits++;
      else misses.push(`${c.id}: missing ${c.expectedTables.filter((t) => !got.has(t)).join(",")}`);
    }
    const accuracy = hits / BENCHMARK.length;
    expect(accuracy, `misses:\n${misses.join("\n")}`).toBeGreaterThanOrEqual(0.85);
  });
});
