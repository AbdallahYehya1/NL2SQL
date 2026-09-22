import { parse } from "libpg-query";
import { ALLOWED_FUNCTIONS, BLOCKED_KEYWORDS, FORBIDDEN_SQL_VALUE_FUNCTIONS, LIMITS } from "@/lib/security/sql-policy";
import { getBuiltinContext, type DatasetContext } from "@/lib/datasets/context";
import type { ValidatedSql, ValidationIssue, ValidationResult } from "@/lib/types";

/**
 * Deterministic SQL validator. Every generated query passes through here before it can reach the database.
 *
 * Layers:
 *   1. length / comment / keyword pre-checks (clear messages, cheap)
 *   2. real PostgreSQL parser (libpg-query) → AST; exactly one SelectStmt
 *   3. AST walk: no write nodes, no INTO / locking, table & schema allow-list, function allow-list,
 *      column existence for resolvable references, complexity limits
 *
 * The result carries a branded `ValidatedSql` that the executor requires, so the validator cannot be skipped.
 */

type AstNode = Record<string, unknown>;

function isObject(v: unknown): v is AstNode {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

const str = (n: unknown): string | undefined => (isObject(n) && isObject(n.String) && typeof n.String.sval === "string" ? n.String.sval : undefined);

/** Replace string literals and quoted identifiers with blanks so keyword scanning ignores their contents. */
function stripLiterals(sql: string): string {
  return sql.replace(/'(?:[^']|'')*'/g, "''").replace(/"(?:[^"]|"")*"/g, '""');
}

/**
 * Validate LLM-generated SQL against ONE dataset. The table allow-list, the column check and the allowed schema are all
 * derived from that dataset's registry — nothing is hard-coded — so a query for dataset A cannot reference dataset B,
 * the application schema, or any system catalog. Defaults to the built-in demo dataset.
 */
export async function validateSql(rawSql: string, dataset: DatasetContext = getBuiltinContext()): Promise<ValidationResult> {
  const { getTable } = dataset.index;
  const allowedSchema = dataset.schemaName;
  const issues: ValidationIssue[] = [];
  const fail = (): ValidationResult => ({ valid: false, issues, tablesUsed: [], columnsUsed: [] });

  const trimmed = (rawSql ?? "").trim();
  if (!trimmed) {
    issues.push({ code: "EMPTY", message: "The SQL statement is empty." });
    return fail();
  }
  if (trimmed.length > LIMITS.maxSqlLength) {
    issues.push({ code: "TOO_LONG", message: `SQL is longer than ${LIMITS.maxSqlLength} characters.` });
    return fail();
  }
  if ([...trimmed].some((ch) => ch.charCodeAt(0) < 32 && ch !== "\n" && ch !== "\r" && ch !== "\t")) {
    issues.push({ code: "PARSE_ERROR", message: "SQL contains control characters." });
    return fail();
  }
  if (trimmed.includes("--") || trimmed.includes("/*") || trimmed.includes("*/")) {
    issues.push({ code: "COMMENT_NOT_ALLOWED", message: "SQL comments (-- or /* */) are not allowed. Remove all comments." });
    return fail();
  }

  const bare = stripLiterals(trimmed);
  const keywordHit = BLOCKED_KEYWORDS.find((k) => new RegExp(`\\b${k}\\b`, "i").test(bare));
  if (keywordHit) {
    issues.push({ code: "WRITE_OPERATION", message: `The keyword ${keywordHit} is not allowed. Only read-only SELECT queries are permitted.` });
    return fail();
  }

  // Strip trailing semicolons (a single terminating ';' is harmless; anything after it is a second statement).
  const sql = trimmed.replace(/;\s*$/, "").trim();

  let ast: { stmts?: { stmt?: AstNode }[] };
  try {
    ast = (await parse(sql)) as typeof ast;
  } catch (err) {
    issues.push({ code: "PARSE_ERROR", message: `SQL syntax error: ${(err as Error).message}` });
    return fail();
  }

  const stmts = ast.stmts ?? [];
  if (stmts.length === 0) {
    issues.push({ code: "EMPTY", message: "The SQL statement is empty." });
    return fail();
  }
  if (stmts.length > 1) {
    issues.push({ code: "MULTIPLE_STATEMENTS", message: "Only a single SQL statement is allowed." });
    return fail();
  }
  const root = stmts[0].stmt;
  if (!root || !isObject(root.SelectStmt)) {
    issues.push({ code: "NOT_SELECT", message: "Only SELECT queries (optionally with WITH) are allowed." });
    return fail();
  }

  const ctx = new WalkContext();
  walk(root, ctx, 0);
  issues.push(...ctx.issues);

  if (ctx.nodeCount > LIMITS.maxAstNodes || ctx.rangeVars.length > LIMITS.maxTables || ctx.cteNames.size > LIMITS.maxCtes) {
    issues.push({ code: "TOO_COMPLEX", message: "The query is too complex. Simplify it (fewer tables, CTEs or nested expressions)." });
  }

  // ── tables ──
  const tables = new Set<string>();
  for (const rv of ctx.rangeVars) {
    const isCte = !rv.schema && ctx.cteNames.has(rv.name);
    if (isCte) continue;
    if (rv.catalog) {
      issues.push({ code: "FORBIDDEN_SCHEMA", message: `Cross-database references (${rv.catalog}.…) are not allowed.` });
      continue;
    }
    if (rv.schema && rv.schema !== allowedSchema) {
      issues.push({ code: "FORBIDDEN_SCHEMA", message: `Schema "${rv.schema}" is not accessible. Use only the tables of this dataset (unqualified, e.g. FROM ${dataset.index.tableNames[0] ?? "table"}).` });
      continue;
    }
    // System-catalog names are refused BEFORE the dataset lookup: PostgreSQL always searches pg_catalog first, so an unqualified
    // `pg_class` reads the real catalog even if the dataset happens to contain a table of that name (uploads of such tables are
    // rejected as well; this is the second layer).
    if (/^(pg_|information_schema)/i.test(rv.name)) {
      issues.push({ code: "SYSTEM_ACCESS", message: `System catalog "${rv.name}" is not accessible.` });
      continue;
    }
    if (!getTable(rv.name)) {
      issues.push({ code: "UNKNOWN_TABLE", message: `Table "${rv.name}" does not exist. Available tables: ${dataset.index.tableNames.join(", ")}.` });
      continue;
    }
    tables.add(rv.name);
  }

  // ── columns ──
  const columnsUsed = new Set<string>();
  resolveColumns(ctx, dataset, tables, issues, columnsUsed);

  if (issues.length) return { valid: false, issues: dedupe(issues), tablesUsed: [...tables], columnsUsed: [...columnsUsed] };
  return { valid: true, issues: [], tablesUsed: [...tables].sort(), columnsUsed: [...columnsUsed].sort(), sql };
}

/** Narrow a validation result to the branded type accepted by the executor. */
export function toValidatedSql(result: ValidationResult): ValidatedSql {
  if (!result.valid || !result.sql) throw new Error("Refusing to brand SQL that did not pass validation.");
  return result.sql as ValidatedSql;
}

function dedupe(issues: ValidationIssue[]): ValidationIssue[] {
  const seen = new Set<string>();
  return issues.filter((i) => {
    const k = `${i.code}:${i.message}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

// ───────────────────────── AST walk ─────────────────────────
interface RangeVarRef {
  catalog?: string;
  schema?: string;
  name: string;
  alias?: string;
}
interface ColumnRef {
  parts: string[];
}

class WalkContext {
  issues: ValidationIssue[] = [];
  rangeVars: RangeVarRef[] = [];
  cteNames = new Set<string>();
  columnRefs: ColumnRef[] = [];
  selectAliases = new Set<string>();
  /** Aliases introduced by subqueries / functions in FROM, which we cannot resolve to a base table. */
  opaqueAliases = new Set<string>();
  hasSubqueryOrFunctionSource = false;
  nodeCount = 0;
}

const WRITE_NODES = new Set(["InsertStmt", "UpdateStmt", "DeleteStmt", "MergeStmt"]);
const STATEMENT_NODES = new Set([
  "VariableSetStmt", "VariableShowStmt", "TransactionStmt", "CopyStmt", "ExplainStmt", "CallStmt", "DoStmt", "CreateStmt",
  "DropStmt", "AlterTableStmt", "GrantStmt", "TruncateStmt", "LockStmt", "ExecuteStmt", "PrepareStmt", "DeclareCursorStmt",
]);

function walk(node: unknown, ctx: WalkContext, depth: number): void {
  if (depth > 60) {
    ctx.issues.push({ code: "TOO_COMPLEX", message: "The query is nested too deeply." });
    return;
  }
  if (Array.isArray(node)) {
    for (const n of node) walk(n, ctx, depth + 1);
    return;
  }
  if (!isObject(node)) return;
  ctx.nodeCount++;

  for (const [key, value] of Object.entries(node)) {
    switch (key) {
      case "SelectStmt": {
        const s = value as AstNode;
        if (s.intoClause) ctx.issues.push({ code: "SELECT_INTO", message: "SELECT ... INTO is not allowed." });
        if (Array.isArray(s.lockingClause) && s.lockingClause.length) {
          ctx.issues.push({ code: "LOCKING_CLAUSE", message: "Row locking clauses (FOR UPDATE/SHARE) are not allowed." });
        }
        break;
      }
      case "RangeVar": {
        const r = value as AstNode;
        const rv: RangeVarRef = {
          catalog: typeof r.catalogname === "string" ? r.catalogname : undefined,
          schema: typeof r.schemaname === "string" ? r.schemaname : undefined,
          name: String(r.relname),
          alias: isObject(r.alias) && typeof r.alias.aliasname === "string" ? r.alias.aliasname : undefined,
        };
        ctx.rangeVars.push(rv);
        break;
      }
      case "RangeSubselect":
      case "RangeFunction": {
        ctx.hasSubqueryOrFunctionSource = true;
        const alias = isObject((value as AstNode).alias) ? ((value as AstNode).alias as AstNode).aliasname : undefined;
        if (typeof alias === "string") ctx.opaqueAliases.add(alias);
        break;
      }
      case "CommonTableExpr": {
        const name = (value as AstNode).ctename;
        if (typeof name === "string") ctx.cteNames.add(name);
        ctx.hasSubqueryOrFunctionSource = true;
        break;
      }
      case "SubLink":
        ctx.hasSubqueryOrFunctionSource = true;
        break;
      case "ResTarget": {
        const name = (value as AstNode).name;
        if (typeof name === "string") ctx.selectAliases.add(name);
        break;
      }
      case "ColumnRef": {
        const fields = (value as AstNode).fields;
        if (Array.isArray(fields)) {
          const parts: string[] = [];
          let star = false;
          for (const f of fields) {
            const s = str(f);
            if (s !== undefined) parts.push(s);
            else if (isObject(f) && "A_Star" in f) star = true;
          }
          if (!star) ctx.columnRefs.push({ parts });
          else if (parts.length) ctx.columnRefs.push({ parts: [...parts, "*"] });
        }
        break;
      }
      case "FuncCall": {
        const names = ((value as AstNode).funcname as unknown[] | undefined)?.map(str).filter((s): s is string => !!s) ?? [];
        const fn = names[names.length - 1]?.toLowerCase();
        const qualifier = names.length > 1 ? names[0].toLowerCase() : undefined;
        if (!fn || (qualifier && qualifier !== "pg_catalog") || names.length > 2 || !ALLOWED_FUNCTIONS.has(fn)) {
          ctx.issues.push({
            code: "FORBIDDEN_FUNCTION",
            message: `Function "${names.join(".") || "?"}" is not allowed. Use standard SQL aggregate, math, string and date functions only.`,
          });
        }
        break;
      }
      case "SQLValueFunction": {
        const op = (value as AstNode).op;
        if (typeof op === "string" && FORBIDDEN_SQL_VALUE_FUNCTIONS.has(op)) {
          ctx.issues.push({ code: "FORBIDDEN_FUNCTION", message: "Session/user information functions are not allowed." });
        }
        break;
      }
      case "typeName": // TypeCast.typeName is an unwrapped TypeName node
      case "TypeName": {
        const names = ((value as AstNode).names as unknown[] | undefined)?.map(str) ?? [];
        if (names.some((n) => n && /^reg[a-z]*$/i.test(n))) {
          ctx.issues.push({ code: "FORBIDDEN_FUNCTION", message: "Casts to reg* object-identifier types are not allowed." });
        }
        break;
      }
      case "A_Expr": {
        const names = ((value as AstNode).name as unknown[] | undefined)?.map(str).filter((s): s is string => !!s) ?? [];
        if (names.length > 1 && !(names.length === 2 && names[0].toLowerCase() === "pg_catalog")) {
          ctx.issues.push({ code: "FORBIDDEN_FUNCTION", message: "Schema-qualified operators are not allowed." });
        }
        break;
      }
      case "ParamRef":
        ctx.issues.push({ code: "PARSE_ERROR", message: "Query parameters ($1, $2, ...) are not supported. Use literal values." });
        break;
      default:
        if (WRITE_NODES.has(key)) {
          ctx.issues.push({ code: "WRITE_OPERATION", message: "Data-modifying statements are not allowed (not even inside WITH)." });
        } else if (STATEMENT_NODES.has(key)) {
          ctx.issues.push({ code: "NOT_SELECT", message: "Only SELECT queries are allowed." });
        }
    }
    walk(value, ctx, depth + 1);
  }
}

// ───────────────────────── column resolution ─────────────────────────
function resolveColumns(ctx: WalkContext, dataset: DatasetContext, tables: Set<string>, issues: ValidationIssue[], columnsUsed: Set<string>) {
  const { getTable, getColumn } = dataset.index;
  // alias (or table name) → registry table; ambiguous or opaque names are dropped
  const aliasMap = new Map<string, string | null>();
  for (const rv of ctx.rangeVars) {
    if (!rv.schema && ctx.cteNames.has(rv.name)) {
      aliasMap.set(rv.alias ?? rv.name, null);
      continue;
    }
    if (!getTable(rv.name) || (rv.schema && rv.schema !== dataset.schemaName)) continue;
    const key = rv.alias ?? rv.name;
    const prev = aliasMap.get(key);
    aliasMap.set(key, prev === undefined || prev === rv.name ? rv.name : null);
  }
  for (const a of ctx.opaqueAliases) aliasMap.set(a, null);
  for (const c of ctx.cteNames) if (!aliasMap.has(c)) aliasMap.set(c, null);

  const baseTables = [...new Set([...aliasMap.values()].filter((v): v is string => !!v))];
  const singleTable = !ctx.hasSubqueryOrFunctionSource && baseTables.length === 1 ? baseTables[0] : undefined;

  for (const { parts } of ctx.columnRefs) {
    const col = parts[parts.length - 1];
    if (col === "*") continue;

    if (parts.length >= 2) {
      const qualifier = parts[parts.length - 2];
      const table = aliasMap.get(qualifier);
      if (table === undefined) continue; // e.g. whole-row reference or schema-qualified oddity; the DB will judge
      if (table === null) continue; // CTE / subquery / ambiguous alias
      if (getColumn(table, col)) columnsUsed.add(`${table}.${col}`);
      else issues.push({ code: "UNKNOWN_COLUMN", message: `Column "${col}" does not exist on table "${table}"${qualifier !== table ? ` (alias ${qualifier})` : ""}. Columns: ${getTable(table)!.columns.map((c) => c.name).join(", ")}.` });
      continue;
    }

    // unqualified
    if (aliasMap.has(col) || ctx.selectAliases.has(col)) continue;
    if (singleTable) {
      if (getColumn(singleTable, col)) columnsUsed.add(`${singleTable}.${col}`);
      else issues.push({ code: "UNKNOWN_COLUMN", message: `Column "${col}" does not exist on table "${singleTable}". Columns: ${getTable(singleTable)!.columns.map((c) => c.name).join(", ")}.` });
      continue;
    }
    // multi-table: record the column if it is unique across base tables in scope
    const owners = baseTables.filter((t) => getColumn(t, col));
    if (owners.length === 1) columnsUsed.add(`${owners[0]}.${col}`);
  }
  void tables;
}
