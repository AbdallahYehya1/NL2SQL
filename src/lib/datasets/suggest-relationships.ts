import type pg from "pg";
import type { IntrospectedSchema, IntrospectedTable } from "./introspect";
import { quoteIdent } from "./sql-util";

/**
 * CSV files carry no constraints, so relationships cannot be read from the database. We only ever SUGGEST them, and only
 * conservatively: a column `<x>_id` is a candidate when
 *   1. a table named like <x> exists (singular/plural tolerated),
 *   2. that table has a key-like column (`id` / `<x>_id`) that is unique and never NULL,
 *   3. the column types are compatible, and
 *   4. EVERY non-null value of the candidate column exists in the target column (verified with a query).
 * Suggestions are stored unconfirmed. They become real foreign keys — and appear in the metadata registry — only after the
 * user confirms them. Nothing here is ever presented as a guaranteed relationship.
 */

export interface RelationshipSuggestion {
  fromTable: string;
  fromColumn: string;
  toTable: string;
  toColumn: string;
  /** Human-readable evidence, e.g. "all 8,120 non-null values exist in customers.id". */
  evidence: string;
}

const norm = (s: string) => s.toLowerCase().replace(/_/g, "");
const singularize = (s: string) => (s.endsWith("ies") ? `${s.slice(0, -3)}y` : s.endsWith("ses") ? s.slice(0, -2) : s.endsWith("s") && !s.endsWith("ss") ? s.slice(0, -1) : s);

const family = (t: string) => (/^(smallint|integer|bigint)/.test(t) ? "int" : /^(numeric|real|double)/.test(t) ? "num" : /^(text|character)/.test(t) ? "text" : t);

export async function suggestRelationships(pool: pg.Pool | pg.PoolClient, schemaName: string, schema: IntrospectedSchema): Promise<RelationshipSuggestion[]> {
  const out: RelationshipSuggestion[] = [];
  const existing = new Set(schema.tables.flatMap((t) => t.foreignKeys.flatMap((f) => f.columns.map((c) => `${t.name}.${c}`))));
  const q = (t: string) => `${quoteIdent(schemaName)}.${quoteIdent(t)}`;

  for (const t of schema.tables) {
    for (const col of t.columns) {
      const m = col.name.match(/^(.+)_id$/);
      if (!m || existing.has(`${t.name}.${col.name}`) || col.distinctCount === 0) continue;
      const stem = norm(m[1]);
      const targets = schema.tables.filter((o) => o.name !== t.name && [norm(o.name), norm(singularize(o.name))].some((n) => n === stem || singularize(n) === singularize(stem)));
      for (const target of targets) {
        const key = keyColumn(target, m[1]);
        if (!key) continue;
        const keyCol = target.columns.find((c) => c.name === key)!;
        if (family(col.type) !== family(keyCol.type)) continue;
        // target key unique + not null
        if (keyCol.distinctCount !== target.rowCount || target.rowCount === 0) continue;
        const nulls = await pool.query(`SELECT count(*)::int AS n FROM ${q(target.name)} WHERE ${quoteIdent(key)} IS NULL`);
        if (nulls.rows[0].n > 0) continue;
        // every non-null candidate value must exist in the target
        const orphans = await pool.query(
          `SELECT count(*)::int AS n FROM ${q(t.name)} c WHERE c.${quoteIdent(col.name)} IS NOT NULL AND NOT EXISTS (SELECT 1 FROM ${q(target.name)} k WHERE k.${quoteIdent(key)} = c.${quoteIdent(col.name)})`,
        );
        if (orphans.rows[0].n > 0) continue;
        out.push({
          fromTable: t.name,
          fromColumn: col.name,
          toTable: target.name,
          toColumn: key,
          evidence: `all ${col.distinctCount.toLocaleString("en-US")} distinct non-null values of ${t.name}.${col.name} exist in ${target.name}.${key} (unique, never null)`,
        });
        break;
      }
    }
  }
  return out;
}

function keyColumn(t: IntrospectedTable, stem: string): string | undefined {
  if (t.primaryKey.length === 1) return t.primaryKey[0];
  const names = t.columns.map((c) => c.name);
  return ["id", `${stem}_id`, `${singularize(t.name)}_id`].find((n) => names.includes(n));
}
