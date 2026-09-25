import type { TableMeta } from "@/lib/types";
import type { DashboardAnalysis, TableAggregateResult } from "@/lib/dashboard/analyze";
import { profileTable } from "@/lib/dashboard/column-classify";

/** Builds a TableAggregateResult by hand (bypassing any SQL/DB) so engine tests can assert on exact, known numbers. */
export function fakeAgg(
  table: TableMeta,
  data: {
    rowCount: number;
    measures?: Record<string, { sum?: number; avg?: number; min?: number; max?: number; nulls?: number }>;
    dates?: Record<string, { min?: string; max?: string; nulls?: number }>;
    yearLike?: Record<string, { min?: number; max?: number; nulls?: number }>;
    categoricals?: Record<string, { distinct?: number; nulls?: number }>;
  },
): TableAggregateResult {
  const fill = <T extends { nulls?: number }>(rec: Record<string, T> | undefined) =>
    Object.fromEntries(Object.entries(rec ?? {}).map(([k, v]) => [k, { ...v, nulls: v.nulls ?? 0 }])) as Record<string, T & { nulls: number }>;
  return {
    table,
    profile: profileTable(table),
    rowCount: data.rowCount,
    measures: fill(data.measures),
    dates: fill(data.dates),
    yearLike: fill(data.yearLike),
    categoricals: fill(data.categoricals),
  };
}

export function emptyAnalysis(allTables: TableMeta[] = []): DashboardAnalysis {
  return { allTables, ranked: [], supporting: [], warnings: [] };
}

const col = (name: string, type: string, opts: Partial<{ primaryKey: boolean; references: { table: string; column: string } }> = {}) => ({
  name,
  type,
  description: "",
  primaryKey: opts.primaryKey,
  references: opts.references,
});

export const ORDERS_TABLE: TableMeta = {
  name: "orders",
  description: "",
  synonyms: [],
  domain: "uploaded",
  primaryKey: ["id"],
  rowCount: 180,
  columns: [
    col("id", "integer", { primaryKey: true }),
    col("customer_id", "integer", { references: { table: "customers", column: "id" } }),
    col("order_date", "timestamptz"),
    col("total_amount", "numeric(12,2)"),
    col("category", "text"),
    col("status", "text"),
  ],
};

export const CUSTOMERS_TABLE: TableMeta = {
  name: "customers",
  description: "",
  synonyms: [],
  domain: "uploaded",
  primaryKey: ["id"],
  rowCount: 60,
  columns: [col("id", "integer", { primaryKey: true }), col("name", "text"), col("city", "text")],
};

export const MOVIES_TABLE: TableMeta = {
  name: "movies",
  description: "",
  synonyms: [],
  domain: "uploaded",
  primaryKey: ["id"],
  rowCount: 1250,
  columns: [col("id", "integer", { primaryKey: true }), col("title", "text"), col("genre", "text"), col("rating", "numeric(3,1)"), col("release_year", "integer")],
};
