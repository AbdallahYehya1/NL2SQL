import { getBuiltinContext, type DatasetContext } from "@/lib/datasets/context";
import type { RetrievedItem, RoutingResult, SubSchema, SubSchemaColumn, SubSchemaTable } from "@/lib/types";

/**
 * Stage 4 — Sub-Schema Builder.
 *
 * Input : routing result (selected + bridge tables, matched metrics) and the scored metadata items.
 * Output: the minimal schema the SQL generator needs — only relevant tables, only relevant columns,
 *         only valid relationships, plus the business definitions that apply.
 */

const COLUMN_SCORE_THRESHOLD = 0.3;

export function buildSubSchema(routing: RoutingResult, items: RetrievedItem[] = routing.items, dataset: DatasetContext = getBuiltinContext()): SubSchema {
  const { getMetric, getTable } = dataset.index;
  const registry = dataset.registry;
  const inSchema = new Set([...routing.selectedTables, ...routing.bridgeTables]);
  const colScore = new Map<string, number>();
  for (const it of items) if (it.kind === "column" && it.table && it.column) colScore.set(`${it.table}.${it.column}`, it.score);

  // columns the matched metrics need
  const metricColumns = new Set<string>();
  for (const m of routing.matchedMetrics) {
    for (const c of getMetric(m)?.columns ?? []) if (inSchema.has(c.table)) metricColumns.add(`${c.table}.${c.column}`);
  }

  // keys that participate in a join between two tables of the sub-schema
  const joinKeys = new Set<string>();
  for (const r of registry.relationships) {
    if (inSchema.has(r.fromTable) && inSchema.has(r.toTable)) {
      joinKeys.add(`${r.fromTable}.${r.fromColumn}`);
      joinKeys.add(`${r.toTable}.${r.toColumn}`);
    }
  }

  const tables: SubSchemaTable[] = [];
  const ordered = [...routing.selectedTables, ...routing.bridgeTables];
  for (const name of ordered) {
    const meta = getTable(name);
    if (!meta) continue;
    const bridgeOnly = routing.bridgeTables.includes(name) && !routing.selectedTables.includes(name);
    const columns: SubSchemaColumn[] = [];
    for (const c of meta.columns) {
      const key = `${name}.${c.name}`;
      const isKey = c.primaryKey || joinKeys.has(key);
      const include = bridgeOnly
        ? isKey || metricColumns.has(key)
        : isKey || c.core || metricColumns.has(key) || (colScore.get(key) ?? 0) >= COLUMN_SCORE_THRESHOLD;
      if (!include) continue;
      columns.push({
        name: c.name,
        type: c.type,
        description: c.description,
        businessMeaning: c.businessMeaning,
        sampleValues: c.sampleValues,
        primaryKey: c.primaryKey,
        references: c.references && inSchema.has(c.references.table) ? c.references : undefined,
      });
    }
    tables.push({ name, description: meta.description, columns, bridgeOnly });
  }

  const includedColumns = new Set(tables.flatMap((t) => t.columns.map((c) => `${t.name}.${c.name}`)));
  const relationships = registry.relationships.filter(
    (r) => includedColumns.has(`${r.fromTable}.${r.fromColumn}`) && includedColumns.has(`${r.toTable}.${r.toColumn}`),
  );

  const metrics = routing.matchedMetrics
    .map((m) => getMetric(m))
    .filter((m): m is NonNullable<typeof m> => !!m)
    .map((m) => ({ name: m.name, description: m.description, definition: m.definition }));

  return { tables, relationships, metrics, defaults: pickDefaults(dataset, inSchema, routing.matchedMetrics) };
}

/** Documented defaults that apply here: `always` ones, plus those whose table/metric conditions match. Pure data — no table names in code. */
function pickDefaults(dataset: DatasetContext, tables: Set<string>, metrics: string[]) {
  return dataset.registry.defaults.filter(
    (d) => d.always || d.whenTables?.some((t) => tables.has(t)) || d.whenMetrics?.some((m) => metrics.includes(m)),
  );
}

/** Compact summary used in traces (keeps trace JSON small). */
export function summariseSubSchema(schema: SubSchema) {
  return {
    tables: schema.tables.map((t) => t.name),
    columns: schema.tables.flatMap((t) => t.columns.map((c) => `${t.name}.${c.name}`)),
    relationships: schema.relationships.map((r) => `${r.fromTable}.${r.fromColumn} = ${r.toTable}.${r.toColumn}`),
    metrics: schema.metrics.map((m) => m.name),
  };
}
