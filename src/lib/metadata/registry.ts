import { DEFAULTS, METRICS, TABLES } from "./definitions";
import type { ColumnMeta, MetadataItem, MetadataRegistry, MetricMeta, Relationship, TableMeta } from "@/lib/types";

/** Schema that holds the built-in demo tables. */
export const DATA_SCHEMA = "shop";

const unique = (xs: string[]) => [...new Set(xs.filter(Boolean))];

/** Foreign-key relationships derived from the columns' `references` — the single source of truth. */
export function deriveRelationships(tables: TableMeta[]): Relationship[] {
  const rels: Relationship[] = [];
  for (const t of tables) {
    for (const c of t.columns) {
      if (!c.references) continue;
      rels.push({
        fromTable: t.name,
        fromColumn: c.name,
        toTable: c.references.table,
        toColumn: c.references.column,
        description: `${t.name}.${c.name} → ${c.references.table}.${c.references.column} (each ${t.name} row belongs to one ${c.references.table} row)`,
      });
    }
  }
  return rels;
}

// ───────────────────────── registry index (per dataset) ─────────────────────────
/** Lookups over one metadata registry. Every dataset (built-in or uploaded) gets its own index. */
export interface RegistryIndex {
  registry: MetadataRegistry;
  tableNames: string[];
  getTable(name: string): TableMeta | undefined;
  getColumn(table: string, column: string): ColumnMeta | undefined;
  isKnownTable(name: string): boolean;
  /** Foreign-key edges in both directions, used for join-path search. */
  neighbours(table: string): { table: string; rel: Relationship }[];
  /** Shortest FK path (list of tables, inclusive) between two tables, or undefined if disconnected. */
  shortestJoinPath(from: string, to: string): string[] | undefined;
  getMetric(name: string): MetricMeta | undefined;
  /** One retrievable item per table, column and metric (lexical documents / embeddings). */
  items: MetadataItem[];
}

export function createRegistryIndex(reg: MetadataRegistry): RegistryIndex {
  const tableIndex = new Map(reg.tables.map((t) => [t.name, t]));
  const neighbours = (table: string) => {
    const out: { table: string; rel: Relationship }[] = [];
    for (const r of reg.relationships) {
      if (r.fromTable === table && r.toTable !== table) out.push({ table: r.toTable, rel: r });
      else if (r.toTable === table && r.fromTable !== table) out.push({ table: r.fromTable, rel: r });
    }
    return out;
  };
  return {
    registry: reg,
    tableNames: reg.tables.map((t) => t.name),
    getTable: (name) => tableIndex.get(name),
    getColumn: (table, column) => tableIndex.get(table)?.columns.find((c) => c.name === column),
    isKnownTable: (name) => tableIndex.has(name),
    neighbours,
    shortestJoinPath(from, to) {
      if (from === to) return [from];
      const queue: string[][] = [[from]];
      const seen = new Set([from]);
      while (queue.length) {
        const path = queue.shift()!;
        for (const n of neighbours(path[path.length - 1])) {
          if (seen.has(n.table)) continue;
          const next = [...path, n.table];
          if (n.table === to) return next;
          seen.add(n.table);
          queue.push(next);
        }
      }
      return undefined;
    },
    getMetric: (name) => reg.metrics.find((m) => m.name === name),
    items: buildMetadataItems(reg),
  };
}

// ───────────────────────── built-in demo registry ─────────────────────────
export const registry: MetadataRegistry = {
  tables: TABLES,
  relationships: deriveRelationships(TABLES),
  metrics: METRICS,
  defaults: DEFAULTS,
};

/** Index of the built-in e-commerce demo dataset. */
export const builtinIndex: RegistryIndex = createRegistryIndex(registry);

export const TABLE_NAMES: string[] = builtinIndex.tableNames;
export const getTable = builtinIndex.getTable;
export const getColumn = builtinIndex.getColumn;
export const isKnownTable = builtinIndex.isKnownTable;
export const neighbours = builtinIndex.neighbours;
export const getMetric = builtinIndex.getMetric;

/** Shortest FK path between two demo tables. `blocked` is accepted for compatibility and ignored. */
export function shortestJoinPath(from: string, to: string, blocked?: ReadonlySet<string>): string[] | undefined {
  void blocked;
  return builtinIndex.shortestJoinPath(from, to);
}

// ───────────────────────── retrievable items ─────────────────────────

/** One item per table, per column and per metric. Used by lexical retrieval and for embeddings. */
export function buildMetadataItems(reg: MetadataRegistry = registry): MetadataItem[] {
  const items: MetadataItem[] = [];
  for (const t of reg.tables) {
    items.push({
      id: `table:${t.name}`,
      kind: "table",
      table: t.name,
      names: unique([t.name, t.name.replace(/_/g, " "), ...t.synonyms]),
      text: [`Table ${t.name}: ${t.description}`, t.businessMeaning, `Also known as: ${t.synonyms.join(", ")}`, `Columns: ${t.columns.map((c) => c.name).join(", ")}`]
        .filter(Boolean)
        .join(" "),
    });
    for (const c of t.columns) {
      items.push({
        id: `column:${t.name}.${c.name}`,
        kind: "column",
        table: t.name,
        column: c.name,
        names: unique([c.name, c.name.replace(/_/g, " "), ...(c.synonyms ?? [])]),
        text: [
          `Column ${t.name}.${c.name} (${c.type}): ${c.description}`,
          c.businessMeaning,
          c.synonyms?.length ? `Also known as: ${c.synonyms.join(", ")}` : "",
          c.sampleValues?.length ? `Example values: ${c.sampleValues.join(", ")}` : "",
        ]
          .filter(Boolean)
          .join(" "),
      });
    }
  }
  for (const m of reg.metrics) {
    items.push({
      id: `metric:${m.name}`,
      kind: "metric",
      metric: m.name,
      names: unique([m.name, m.name.replace(/_/g, " "), ...m.synonyms]),
      text: `Business metric ${m.name}: ${m.description} ${m.definition} Also known as: ${m.synonyms.join(", ")}`,
    });
  }
  return items;
}
