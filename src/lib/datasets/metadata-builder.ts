import { deriveRelationships } from "@/lib/metadata/registry";
import type { ColumnMeta, DefaultRule, MetadataRegistry, TableMeta } from "@/lib/types";
import type { IntrospectedSchema, IntrospectedTable } from "./introspect";

/**
 * Introspected structure → the SAME MetadataRegistry format the built-in demo uses. No hand-written metadata needed.
 *
 *  - Structure (tables, columns, types, nullability, keys, relationships, row counts, sample values) comes from the
 *    database catalogs and always wins.
 *  - Descriptions come, in priority order, from `COMMENT ON` statements in the upload (source "database"), an optional
 *    LLM pass (source "llm", clearly marked, applied only to names that exist and only where no database comment exists),
 *    or a deterministic template (source "generated").
 */

export interface LlmDescriptions {
  tables: Record<string, string>;
  columns: Record<string, Record<string, string>>;
}

/** "order_items" → "order items" */
const words = (name: string) => name.replace(/_+/g, " ").trim();

function singular(w: string): string {
  if (w.endsWith("ies") && w.length > 4) return `${w.slice(0, -3)}y`;
  if (w.endsWith("sses")) return w.slice(0, -2);
  if (w.endsWith("ss") || w.endsWith("us")) return w;
  if (w.endsWith("s") && w.length > 3) return w.slice(0, -1);
  return w;
}
function plural(w: string): string {
  if (w.endsWith("y") && !/[aeiou]y$/.test(w)) return `${w.slice(0, -1)}ies`;
  if (w.endsWith("s")) return w;
  return `${w}s`;
}

const unique = (xs: string[]) => [...new Set(xs.filter(Boolean))];

export const GENERIC_DEFAULTS: DefaultRule[] = [
  {
    name: "relative_dates",
    always: true,
    description:
      "Relative periods are computed from CURRENT_DATE in UTC, applied to the date/timestamp column most relevant to the question. 'Last month' = the previous full calendar month (>= date_trunc('month', CURRENT_DATE) - interval '1 month' AND < date_trunc('month', CURRENT_DATE)); 'last year' = the previous full calendar year.",
  },
  { name: "ranking", always: true, description: "'Top' / 'best' rankings without an explicit N return the top 10, ordered descending by the measure." },
  { name: "rounding", always: true, description: "Monetary amounts and averages are rounded to 2 decimals with ROUND(x::numeric, 2)." },
  {
    name: "counting",
    always: true,
    description: "'How many <things>' counts rows of the table that stores those things (COUNT(*)); count DISTINCT ids when a join could repeat rows.",
  },
];

export function buildRegistryFromIntrospection(
  schema: IntrospectedSchema,
  options: { comments?: { table: string; column?: string; text: string }[]; llm?: LlmDescriptions; previous?: MetadataRegistry } = {},
): MetadataRegistry {
  const tableComments = new Map<string, string>();
  const columnComments = new Map<string, string>();
  for (const c of options.comments ?? []) {
    if (c.column) columnComments.set(`${c.table}.${c.column}`, c.text);
    else tableComments.set(c.table, c.text);
  }
  const prevTable = new Map((options.previous?.tables ?? []).map((t) => [t.name, t]));

  const tables: TableMeta[] = schema.tables.map((t) => buildTable(t, tableComments, columnComments, options.llm, prevTable.get(t.name)));
  return { tables, relationships: deriveRelationships(tables), metrics: [], defaults: GENERIC_DEFAULTS };
}

function buildTable(
  t: IntrospectedTable,
  tableComments: Map<string, string>,
  columnComments: Map<string, string>,
  llm: LlmDescriptions | undefined,
  previous: TableMeta | undefined,
): TableMeta {
  const fkByColumn = new Map<string, { table: string; column: string }>();
  for (const fk of t.foreignKeys) fk.columns.forEach((c, i) => fkByColumn.set(c, { table: fk.refTable, column: fk.refColumns[i] ?? fk.refColumns[0] }));

  const base = singular(words(t.name));
  const dbComment = t.comment ?? tableComments.get(t.name);
  const llmDesc = llm?.tables[t.name];
  const prevLlm = previous?.descriptionSource === "llm" ? previous.description : undefined;
  const generated = `${capitalize(words(t.name))}: ${t.rowCount.toLocaleString("en-US")} rows with columns ${t.columns.slice(0, 8).map((c) => c.name).join(", ")}${t.columns.length > 8 ? ", …" : ""}.`;
  const description = dbComment ?? llmDesc ?? prevLlm ?? generated;
  const descriptionSource = dbComment ? "database" : llmDesc || prevLlm ? "llm" : "generated";

  const many = t.columns.length > 15;
  const columns: ColumnMeta[] = t.columns.map((c) => {
    const ref = fkByColumn.get(c.name);
    const isPk = t.primaryKey.includes(c.name);
    const dbCol = c.comment ?? columnComments.get(`${t.name}.${c.name}`);
    const llmCol = llm?.columns[t.name]?.[c.name];
    const prevCol = previous?.columns.find((pc) => pc.name === c.name);
    const prevLlmCol = prevCol?.descriptionSource === "llm" ? prevCol.description : undefined;
    const parts = [`${capitalize(words(c.name))} of the ${base}`];
    if (isPk) parts.push("primary key");
    if (ref) parts.push(`references ${ref.table}.${ref.column}`);
    const generatedCol = `${parts.join("; ")} (${c.type}${c.nullable ? "" : ", not null"})`;
    const colDesc = dbCol ?? llmCol ?? prevLlmCol ?? generatedCol;
    const w = words(c.name);
    const stripped = w.replace(/ id$/, "");
    return {
      name: c.name,
      type: c.type,
      description: colDesc,
      descriptionSource: dbCol ? "database" : llmCol || prevLlmCol ? "llm" : "generated",
      nullable: c.nullable,
      sampleValues: c.sampleValues.length ? c.sampleValues : undefined,
      synonyms: unique([w !== c.name ? w : "", stripped !== w ? stripped : ""]),
      primaryKey: isPk || undefined,
      references: ref,
      core: !many || isPk || !!ref || /(^|_)(name|title|label|date|time|amount|total|price|count|status|type|category)($|_)/.test(c.name) || undefined,
    };
  });

  const refTables = unique(t.foreignKeys.map((f) => f.refTable));
  return {
    name: t.name,
    description,
    descriptionSource,
    businessMeaning: refTables.length ? `Each row belongs to: ${refTables.join(", ")}.` : undefined,
    synonyms: unique([words(t.name), base, plural(base)]),
    columns,
    primaryKey: t.primaryKey,
    domain: "uploaded",
    rowCount: t.rowCount,
  };
}

const capitalize = (s: string) => (s ? s[0].toUpperCase() + s.slice(1) : s);
