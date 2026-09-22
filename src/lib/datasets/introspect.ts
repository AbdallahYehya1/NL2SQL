import type pg from "pg";
import type { UploadLimits } from "./limits";
import { quoteIdent } from "./sql-util";

/**
 * Reads the REAL structure of an imported dataset from the PostgreSQL catalogs (pg_class / pg_attribute / pg_constraint).
 * The metadata registry is built from this — never from what the uploaded file "claims" — so actual database structure
 * always wins. Data access is bounded: exact row counts, per-column distinct counts, and a handful of sample values.
 */

export interface IntrospectedColumn {
  name: string;
  /** format_type() output, e.g. "integer", "numeric(10,2)", "timestamp with time zone". */
  type: string;
  nullable: boolean;
  hasDefault: boolean;
  comment?: string;
  distinctCount: number;
  sampleValues: string[];
}

export interface IntrospectedForeignKey {
  columns: string[];
  refTable: string;
  refColumns: string[];
}

export interface IntrospectedTable {
  name: string;
  comment?: string;
  rowCount: number;
  columns: IntrospectedColumn[];
  primaryKey: string[];
  foreignKeys: IntrospectedForeignKey[];
  uniqueKeys: string[][];
}

export interface IntrospectedSchema {
  tables: IntrospectedTable[];
}

// Names that hint at personal / secret data: their values are never placed in metadata, prompts or embeddings.
const SENSITIVE_NAME = /(pass(word|wd)?|pwd|secret|token|api[_-]?key|ssn|social[_-]?sec|credit|card[_-]?(no|num)|iban|cvv|pin\b|e[_-]?mail|phone|mobile|tel\b|fax|address|street|birth|dob|passport|license|lat(itude)?\b|lon(gitude)?\b|(first|last|full|sur|middle|given|family)[_ ]?name)/i;
const EMAIL_LIKE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const LONG_DIGITS = /^\+?[0-9][0-9 ().-]{8,}$/;
const TOKEN_LIKE = /^[A-Za-z0-9+/_=-]{24,}$/;

export function looksSensitive(columnName: string, values: string[]): boolean {
  if (SENSITIVE_NAME.test(columnName)) return true;
  return values.some((v) => EMAIL_LIKE.test(v) || LONG_DIGITS.test(v) || TOKEN_LIKE.test(v));
}

const NUMERIC_OR_TEMPORAL = /^(smallint|integer|bigint|numeric|real|double precision|boolean|date|time|timestamp|interval)/;

const asArray = (v: unknown): string[] => {
  if (Array.isArray(v)) return v.map(String);
  if (typeof v === "string") {
    const inner = v.replace(/^\{|\}$/g, "");
    return inner === "" ? [] : inner.split(",").map((x) => x.replace(/^"|"$/g, ""));
  }
  return [];
};

export async function introspectSchema(pool: pg.Pool | pg.PoolClient, schema: string, limits: UploadLimits): Promise<IntrospectedSchema> {
  const tablesRes = await pool.query(
    `SELECT c.oid, c.relname AS name, obj_description(c.oid, 'pg_class') AS comment
       FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = $1 AND c.relkind IN ('r','p') ORDER BY c.relname`,
    [schema],
  );
  const colsRes = await pool.query(
    `SELECT c.relname AS table_name, a.attname AS name, format_type(a.atttypid, a.atttypmod) AS type, NOT a.attnotnull AS nullable,
            a.atthasdef AS has_default, col_description(c.oid, a.attnum) AS comment
       FROM pg_attribute a JOIN pg_class c ON c.oid = a.attrelid JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = $1 AND c.relkind IN ('r','p') AND a.attnum > 0 AND NOT a.attisdropped
      ORDER BY c.relname, a.attnum`,
    [schema],
  );
  const consRes = await pool.query(
    `SELECT rel.relname AS table_name, con.contype AS type, frel.relname AS ref_table,
            (SELECT array_agg(a.attname::text ORDER BY k.ord) FROM unnest(con.conkey) WITH ORDINALITY k(attnum, ord)
               JOIN pg_attribute a ON a.attrelid = con.conrelid AND a.attnum = k.attnum) AS cols,
            (SELECT array_agg(a.attname::text ORDER BY k.ord) FROM unnest(con.confkey) WITH ORDINALITY k(attnum, ord)
               JOIN pg_attribute a ON a.attrelid = con.confrelid AND a.attnum = k.attnum) AS ref_cols
       FROM pg_constraint con JOIN pg_class rel ON rel.oid = con.conrelid JOIN pg_namespace n ON n.oid = rel.relnamespace
       LEFT JOIN pg_class frel ON frel.oid = con.confrelid
      WHERE n.nspname = $1 AND con.contype IN ('p','u','f')`,
    [schema],
  );

  const tables: IntrospectedTable[] = [];
  for (const t of tablesRes.rows) {
    const tname = t.name as string;
    const cols = colsRes.rows.filter((c) => c.table_name === tname);
    const qt = `${quoteIdent(schema)}.${quoteIdent(tname)}`;

    // exact row count + distinct count of every column in ONE query
    const countSql = `SELECT count(*)::bigint AS n${cols.map((c, i) => `, count(DISTINCT ${quoteIdent(c.name)})::bigint AS d${i}`).join("")} FROM ${qt}`;
    const counts = (await pool.query(countSql)).rows[0];

    // a bounded sample of rows (never the whole table) for example values
    const sample = (await pool.query(`SELECT ${cols.map((c) => `${quoteIdent(c.name)}::text AS ${quoteIdent(c.name)}`).join(", ")} FROM ${qt} LIMIT 200`)).rows;

    const columns: IntrospectedColumn[] = [];
    for (let i = 0; i < cols.length; i++) {
      const c = cols[i];
      const distinct = Number(counts[`d${i}`]);
      const fromSample = [...new Set(sample.map((r) => r[c.name] as string | null).filter((v): v is string => v !== null && v !== ""))];
      let samples: string[] = [];
      if (!looksSensitive(c.name, fromSample)) {
        // "categorical" = few distinct values that actually REPEAT (identifier-like columns, where every row differs, are skipped)
        if (distinct > 0 && distinct <= limits.categoricalMaxDistinct && distinct < Number(counts.n)) {
          // low-cardinality ("categorical") column: list ALL values so the model knows the valid options
          const all = await pool.query(`SELECT DISTINCT ${quoteIdent(c.name)}::text AS v FROM ${qt} WHERE ${quoteIdent(c.name)} IS NOT NULL ORDER BY 1 LIMIT ${limits.categoricalMaxDistinct + 1}`);
          samples = all.rows.map((r) => String(r.v));
        } else if (NUMERIC_OR_TEMPORAL.test(c.type)) {
          samples = fromSample.slice(0, 3);
        }
        // high-cardinality text / uuid / json: no values at all (names, free text and ids are the most sensitive)
      }
      columns.push({
        name: c.name,
        type: c.type,
        nullable: c.nullable,
        hasDefault: c.has_default,
        comment: c.comment ?? undefined,
        distinctCount: distinct,
        sampleValues: samples.map((s) => (s.length > 40 ? `${s.slice(0, 39)}…` : s)).slice(0, limits.categoricalMaxDistinct),
      });
    }

    const mine = consRes.rows.filter((r) => r.table_name === tname);
    tables.push({
      name: tname,
      comment: t.comment ?? undefined,
      rowCount: Number(counts.n),
      columns,
      primaryKey: asArray(mine.find((r) => r.type === "p")?.cols),
      foreignKeys: mine.filter((r) => r.type === "f").map((r) => ({ columns: asArray(r.cols), refTable: r.ref_table as string, refColumns: asArray(r.ref_cols) })),
      uniqueKeys: mine.filter((r) => r.type === "u").map((r) => asArray(r.cols)),
    });
  }
  return { tables };
}
