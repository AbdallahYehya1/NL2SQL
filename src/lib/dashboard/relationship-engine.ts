import type { DatasetContext } from "@/lib/datasets/context";
import type { DashboardRelationships } from "./types";

/** Thin wrapper over the registry's own FK relationships — no relationship is ever invented here. */
export function buildRelationships(dataset: DatasetContext): DashboardRelationships {
  return {
    edges: dataset.registry.relationships.map((r) => ({ fromTable: r.fromTable, fromColumn: r.fromColumn, toTable: r.toTable, toColumn: r.toColumn })),
    tables: dataset.registry.tables.map((t) => t.name),
  };
}
