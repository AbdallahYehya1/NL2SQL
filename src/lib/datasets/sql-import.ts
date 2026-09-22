import { parse } from "libpg-query";
import { ALLOWED_FUNCTIONS, FORBIDDEN_SQL_VALUE_FUNCTIONS } from "@/lib/security/sql-policy";
import { ImportError, UNSUPPORTED_SQL_MESSAGE, type UploadLimits } from "./limits";

/**
 * Turns an uploaded .sql file into an EXECUTION PLAN — without executing anything.
 *
 * The whole file is parsed with PostgreSQL's own parser and every statement is checked against a small allow-list
 * (ordinary relational DDL + literal INSERTs). If ANY statement is unsupported the whole file is rejected before a
 * single statement runs ("Do not partially execute dangerous SQL"). Only the statements that pass are ever executed,
 * and only inside a brand-new, isolated schema (see import-service.ts).
 *
 * Supported : CREATE TABLE, CREATE INDEX (btree, plain columns), ALTER TABLE … ADD PRIMARY KEY / UNIQUE / FOREIGN KEY / CHECK,
 *             ALTER TABLE … SET DEFAULT / SET NOT NULL, INSERT … VALUES (literals), COMMENT ON TABLE/COLUMN (become
 *             descriptions), and harmless BEGIN/COMMIT, `SET client_encoding`-style lines and OWNER TO (ignored).
 * Rejected  : everything else — DROP/CREATE DATABASE, GRANT/REVOKE, roles, extensions, foreign data wrappers, COPY,
 *             functions/triggers/views, SELECT/UPDATE/DELETE, DO blocks, session settings, …
 */

type AstNode = Record<string, unknown>;
const isObj = (v: unknown): v is AstNode => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (n: unknown): string | undefined => (isObj(n) && isObj(n.String) && typeof n.String.sval === "string" ? n.String.sval : undefined);
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const unwrap = (n: unknown, key: string): AstNode | undefined => (isObj(n) && isObj(n[key]) ? (n[key] as AstNode) : undefined);

export interface PlannedStatement {
  /** Text to execute (schema prefix `public.` removed). */
  text: string;
  kind: "create_table" | "create_index" | "alter_table" | "insert";
  table?: string;
  rows?: number;
  line: number;
}

export interface SqlImportPlan {
  statements: PlannedStatement[];
  /** COMMENT ON … texts, applied as descriptions by the metadata builder (never executed). */
  comments: { table: string; column?: string; text: string }[];
  stats: { tables: string[]; columns: number; rows: number; statements: number };
  /** Non-fatal notes shown in the preview (e.g. ignored statements). */
  warnings: string[];
}

const ALLOWED_TYPES = new Set([
  "int2", "int4", "int8", "float4", "float8", "numeric", "bool", "bpchar", "varchar", "text", "date", "time", "timetz", "timestamp", "timestamptz",
  "interval", "uuid", "json", "jsonb", "serial", "bigserial", "smallserial", "serial2", "serial4", "serial8",
]);

const BENIGN_SETTINGS = new Set([
  "client_encoding", "standard_conforming_strings", "check_function_bodies", "client_min_messages", "statement_timeout", "lock_timeout",
  "idle_in_transaction_session_timeout", "row_security", "xmloption", "default_table_access_method",
]);

/** Human names for statements we refuse, used in the error details. */
const UNSUPPORTED_LABELS: Record<string, string> = {
  DropdbStmt: "DROP DATABASE",
  CreatedbStmt: "CREATE DATABASE",
  GrantStmt: "GRANT / REVOKE",
  GrantRoleStmt: "GRANT / REVOKE (roles)",
  CreateRoleStmt: "CREATE ROLE",
  AlterRoleStmt: "ALTER ROLE",
  AlterRoleSetStmt: "ALTER ROLE … SET",
  DropRoleStmt: "DROP ROLE",
  CreateExtensionStmt: "CREATE EXTENSION (extensions are not allowed)",
  AlterExtensionStmt: "ALTER EXTENSION",
  CreateFdwStmt: "CREATE FOREIGN DATA WRAPPER",
  CreateForeignServerStmt: "CREATE SERVER (foreign data / network access)",
  CreateForeignTableStmt: "CREATE FOREIGN TABLE",
  CreateUserMappingStmt: "CREATE USER MAPPING",
  CopyStmt: "COPY (server-side file/program access is not allowed; use INSERT statements)",
  DropStmt: "DROP",
  TruncateStmt: "TRUNCATE",
  DoStmt: "DO block",
  CreateFunctionStmt: "CREATE FUNCTION / PROCEDURE",
  CreateTrigStmt: "CREATE TRIGGER",
  ViewStmt: "CREATE VIEW",
  CreateSeqStmt: "CREATE SEQUENCE (use SERIAL or GENERATED … AS IDENTITY instead)",
  AlterSeqStmt: "ALTER SEQUENCE",
  CreateEnumStmt: "CREATE TYPE … AS ENUM (use text with a CHECK constraint instead)",
  CompositeTypeStmt: "CREATE TYPE",
  CreateDomainStmt: "CREATE DOMAIN",
  CreateSchemaStmt: "CREATE SCHEMA (the dataset gets its own schema automatically)",
  SelectStmt: "SELECT (only INSERT … VALUES is allowed for data)",
  UpdateStmt: "UPDATE",
  DeleteStmt: "DELETE",
  MergeStmt: "MERGE",
  VariableSetStmt: "SET (session/server settings)",
  VariableShowStmt: "SHOW",
  ExplainStmt: "EXPLAIN",
  CallStmt: "CALL",
  ListenStmt: "LISTEN",
  NotifyStmt: "NOTIFY",
  LockStmt: "LOCK",
  VacuumStmt: "VACUUM / ANALYZE",
  ClusterStmt: "CLUSTER",
  ReindexStmt: "REINDEX",
  RefreshMatViewStmt: "REFRESH MATERIALIZED VIEW",
  CreateTableAsStmt: "CREATE TABLE AS / SELECT INTO (data must come from INSERT … VALUES)",
  CreatePolicyStmt: "CREATE POLICY",
  AlterOwnerStmt: "ALTER … OWNER",
  RenameStmt: "ALTER … RENAME",
  AlterObjectSchemaStmt: "ALTER … SET SCHEMA",
  CreateTableSpaceStmt: "CREATE TABLESPACE",
  CreatePublicationStmt: "CREATE PUBLICATION",
  CreateSubscriptionStmt: "CREATE SUBSCRIPTION",
  DeclareCursorStmt: "DECLARE CURSOR",
  PrepareStmt: "PREPARE",
  ExecuteStmt: "EXECUTE",
  LoadStmt: "LOAD",
  DiscardStmt: "DISCARD",
  SecLabelStmt: "SECURITY LABEL",
  ImportForeignSchemaStmt: "IMPORT FOREIGN SCHEMA",
};

interface Removal {
  /** absolute byte offset of the `public.` prefix */
  at: number;
}

class Checker {
  issues: string[] = [];
  removals: Removal[] = [];
  constructor(private lineAt: (byteOffset: number) => number) {}

  issue(message: string, byteOffset: number) {
    if (this.issues.length < 25) this.issues.push(`line ${this.lineAt(byteOffset)}: ${message}`);
  }
}

/** Reads and validates every RangeVar in a statement subtree; schema prefix `public.` is queued for removal. */
function checkRangeVars(node: unknown, at: number, chk: Checker) {
  if (Array.isArray(node)) return node.forEach((n) => checkRangeVars(n, at, chk));
  if (!isObj(node)) return;
  if (typeof node.relname === "string") return checkOneRangeVar(node, at, chk); // a bare RangeVar (relation / pktable)
  for (const [k, v] of Object.entries(node)) {
    if (k === "RangeVar" && isObj(v)) checkOneRangeVar(v, at, chk);
    else if ((k === "pktable" || k === "relation") && isObj(v) && "relname" in v) checkOneRangeVar(v, at, chk);
    else checkRangeVars(v, at, chk);
  }
}

function checkOneRangeVar(rv: AstNode, at: number, chk: Checker) {
  if (rv.catalogname) chk.issue("cross-database references are not supported", at);
  if (rv.relpersistence === "t") chk.issue("TEMPORARY tables are not supported", at);
  const schema = typeof rv.schemaname === "string" ? rv.schemaname : undefined;
  if (schema === undefined) return;
  if (schema === "public" && typeof rv.location === "number") chk.removals.push({ at: rv.location });
  else chk.issue(`schema-qualified name "${schema}.${String(rv.relname)}" is not supported (only unqualified names or public.<name>)`, at);
}

/** Expressions in DEFAULT / CHECK / VALUES: constants and allow-listed functions only. */
function checkExpr(node: unknown, at: number, chk: Checker, opts: { allowColumns: boolean }) {
  if (Array.isArray(node)) return node.forEach((n) => checkExpr(n, at, chk, opts));
  if (!isObj(node)) return;
  for (const [k, v] of Object.entries(node)) {
    switch (k) {
      case "SubLink":
      case "SelectStmt":
        chk.issue("sub-queries are not allowed in defaults, CHECK constraints or VALUES", at);
        return;
      case "ParamRef":
        chk.issue("query parameters are not supported", at);
        break;
      case "ColumnRef":
        if (!opts.allowColumns) chk.issue("column references are not allowed here", at);
        break;
      case "FuncCall": {
        const names = arr(isObj(v) ? v.funcname : undefined).map(str).filter((s): s is string => !!s);
        const fn = names[names.length - 1]?.toLowerCase();
        if (!fn || names.length > 2 || (names.length === 2 && names[0].toLowerCase() !== "pg_catalog") || !ALLOWED_FUNCTIONS.has(fn)) {
          chk.issue(`function "${names.join(".") || "?"}" is not allowed in defaults/CHECK/VALUES`, at);
        }
        break;
      }
      case "SQLValueFunction":
        if (isObj(v) && typeof v.op === "string" && FORBIDDEN_SQL_VALUE_FUNCTIONS.has(v.op)) chk.issue("session-information functions are not allowed", at);
        break;
      default:
    }
    checkExpr(v, at, chk, opts);
  }
}

function checkTypeName(t: unknown, at: number, chk: Checker) {
  if (!isObj(t)) return;
  const names = arr(t.names).map(str).filter((s): s is string => !!s);
  const last = names[names.length - 1]?.toLowerCase();
  if (arr(t.arrayBounds).length) chk.issue("array columns are not supported", at);
  else if (names.length > 2 || (names.length === 2 && names[0].toLowerCase() !== "pg_catalog") || !last || !ALLOWED_TYPES.has(last)) {
    chk.issue(`data type "${names.join(".") || "?"}" is not supported (supported: integer/bigint/numeric/float, text/varchar/char, boolean, date/time/timestamp/interval, uuid, json/jsonb)`, at);
  }
}

const ALLOWED_CONSTRAINTS = new Set(["CONSTR_PRIMARY", "CONSTR_UNIQUE", "CONSTR_FOREIGN", "CONSTR_CHECK"]);

function checkConstraint(c: AstNode, at: number, chk: Checker, allowColumnExprs: boolean) {
  const ct = String(c.contype);
  if (ct === "CONSTR_NOTNULL" || ct === "CONSTR_NULL" || ct === "CONSTR_IDENTITY") return;
  if (ct === "CONSTR_DEFAULT") return checkExpr(c.raw_expr, at, chk, { allowColumns: false });
  if (ct === "CONSTR_GENERATED") return checkExpr(c.raw_expr, at, chk, { allowColumns: true });
  if (!ALLOWED_CONSTRAINTS.has(ct)) return chk.issue(`constraint type ${ct.replace("CONSTR_", "")} is not supported`, at);
  if (c.indexname || c.indexspace || arr(c.options).length || arr(c.including).length || c.where_clause || arr(c.exclusions).length) {
    chk.issue("constraint options (USING INDEX, WITH, WHERE, INCLUDE, …) are not supported", at);
  }
  if (ct === "CONSTR_CHECK") checkExpr(c.raw_expr, at, chk, { allowColumns: allowColumnExprs });
}

const lineOf = (buf: Buffer, byteOffset: number) => {
  let n = 1;
  for (let i = 0; i < Math.min(byteOffset, buf.length); i++) if (buf[i] === 10) n++;
  return n;
};

export async function planSqlImport(sql: string, limits: UploadLimits): Promise<SqlImportPlan> {
  const buf = Buffer.from(sql.replace(/^﻿/, ""), "utf8");
  if (buf.length === 0 || sql.trim() === "") throw new ImportError("The SQL file is empty.");
  if (buf.length > limits.maxSqlBytes) throw new ImportError(`The SQL file is too large (max ${Math.round(limits.maxSqlBytes / 1024 / 1024)} MB).`);
  if (buf.includes(0)) throw new ImportError("The file contains binary data and is not a SQL text file.");
  const text = buf.toString("utf8");

  let ast: { stmts?: { stmt?: AstNode; stmt_location?: number; stmt_len?: number }[] };
  try {
    ast = (await parse(text)) as typeof ast;
  } catch (err) {
    const pos = (err as { sqlDetails?: { cursorPosition?: number } }).sqlDetails?.cursorPosition;
    const where = typeof pos === "number" ? ` near line ${lineOf(buf, Math.max(0, pos - 1))}` : "";
    throw new ImportError(`The SQL file could not be parsed${where}: ${(err as Error).message}`);
  }
  const stmts = ast.stmts ?? [];
  if (stmts.length === 0) throw new ImportError("The SQL file contains no statements.");
  if (stmts.length > limits.maxSqlStatements) throw new ImportError(`Too many SQL statements (max ${limits.maxSqlStatements}).`);

  const chk = new Checker((off) => lineOf(buf, off));
  const planned: PlannedStatement[] = [];
  const comments: SqlImportPlan["comments"] = [];
  const warnings: string[] = [];
  const unsupported: string[] = [];
  const declared = new Map<string, number>(); // table → column count
  let rows = 0;
  let totalColumns = 0;
  const skippedKinds = new Set<string>();

  for (const entry of stmts) {
    const node = entry.stmt;
    if (!node) continue;
    const at = entry.stmt_location ?? 0;
    const len = entry.stmt_len && entry.stmt_len > 0 ? entry.stmt_len : buf.length - at;
    const kind = Object.keys(node)[0];
    const body = node[kind] as AstNode;
    const removalsBefore = chk.removals.length;

    const push = (k: PlannedStatement["kind"], extra: Partial<PlannedStatement> = {}) => {
      const stmtBuf = Buffer.from(buf.subarray(at, at + len));
      // remove `public.` prefixes (AST-guided, byte-exact), highest offset first
      const mine = chk.removals.slice(removalsBefore).sort((a, b) => b.at - a.at);
      let cur = stmtBuf;
      for (const r of mine) {
        const rel = r.at - at;
        if (rel < 0 || rel >= cur.length) continue;
        const head = cur.subarray(rel, rel + 24).toString("utf8");
        const m = head.match(/^"?public"?\s*\.\s*/i);
        if (m) cur = Buffer.concat([cur.subarray(0, rel), cur.subarray(rel + Buffer.byteLength(m[0]))]);
        else chk.issue("could not safely rewrite the schema prefix of a name", at);
      }
      planned.push({ text: cur.toString("utf8"), kind: k, line: lineOf(buf, at), ...extra });
    };

    switch (kind) {
      case "TransactionStmt": {
        const k = String(body.kind);
        if (k === "TRANS_STMT_BEGIN" || k === "TRANS_STMT_START" || k === "TRANS_STMT_COMMIT") skippedKinds.add("BEGIN/COMMIT");
        else unsupported.push(`line ${lineOf(buf, at)}: ${k.replace("TRANS_STMT_", "")} (transaction control other than BEGIN/COMMIT)`);
        break;
      }
      case "VariableSetStmt": {
        const name = String(body.name ?? "").toLowerCase();
        if (String(body.kind) === "VAR_SET_VALUE" && BENIGN_SETTINGS.has(name)) skippedKinds.add(`SET ${name}`);
        else unsupported.push(`line ${lineOf(buf, at)}: SET ${name || "…"} (session/server settings are not allowed)`);
        break;
      }
      case "CommentStmt": {
        const items = arr(isObj(body.object) ? (body.object.List as AstNode | undefined)?.items : undefined).map(str).filter((s): s is string => !!s);
        const text = typeof body.comment === "string" ? body.comment : "";
        if (body.objtype === "OBJECT_TABLE" && items.length >= 1 && text) {
          if (items.length === 2 && items[0] !== "public") chk.issue("COMMENT on a schema-qualified table is not supported", at);
          else comments.push({ table: items[items.length - 1], text });
        } else if (body.objtype === "OBJECT_COLUMN" && items.length >= 2 && text) {
          if (items.length === 3 && items[0] !== "public") chk.issue("COMMENT on a schema-qualified column is not supported", at);
          else comments.push({ table: items[items.length - 2], column: items[items.length - 1], text });
        } else skippedKinds.add("COMMENT (other objects)");
        break;
      }
      case "CreateStmt": {
        checkRangeVars(body.relation, at, chk);
        const rel = body.relation as AstNode;
        const table = String(rel.relname);
        if (arr(body.inhRelations).length) chk.issue("table inheritance (INHERITS) is not supported", at);
        if (body.partbound || body.partspec) chk.issue("partitioned tables are not supported", at);
        if (arr(body.options).length || body.tablespacename || body.accessMethod) chk.issue("table storage options (WITH, TABLESPACE, USING) are not supported", at);
        if (body.ofTypename) chk.issue("typed tables are not supported", at);
        if (/^(pg_|information_schema)/i.test(table)) chk.issue(`table name "${table}" is reserved (names starting with pg_ are PostgreSQL system-catalog names)`, at);
        if (rel.relpersistence === "u") chk.issue("UNLOGGED tables are not supported", at);
        let cols = 0;
        for (const el of arr(body.tableElts)) {
          const cd = unwrap(el, "ColumnDef");
          const con = unwrap(el, "Constraint");
          if (cd) {
            cols++;
            checkTypeName(cd.typeName, at, chk);
            if (cd.collClause || cd.compression || cd.storage) chk.issue("column collation / compression / storage options are not supported", at);
            for (const c of arr(cd.constraints)) {
              const cc = unwrap(c, "Constraint");
              if (cc) {
                checkConstraint(cc, at, chk, true);
                if (cc.pktable) checkRangeVars(cc.pktable, at, chk);
              }
            }
          } else if (con) {
            checkConstraint(con, at, chk, true);
            if (con.pktable) checkRangeVars(con.pktable, at, chk);
          } else chk.issue("only column definitions and constraints are supported inside CREATE TABLE (no LIKE)", at);
        }
        if (cols > limits.maxColumnsPerTable) chk.issue(`table "${table}" has ${cols} columns (max ${limits.maxColumnsPerTable})`, at);
        if (declared.has(table)) chk.issue(`table "${table}" is created twice`, at);
        declared.set(table, cols);
        totalColumns += cols;
        push("create_table", { table });
        break;
      }
      case "IndexStmt": {
        checkRangeVars(body.relation, at, chk);
        const am = typeof body.accessMethod === "string" ? body.accessMethod : "btree";
        if (am !== "btree") chk.issue(`index method "${am}" is not supported (btree only)`, at);
        if (body.concurrent) chk.issue("CREATE INDEX CONCURRENTLY is not supported (the import runs in one transaction)", at);
        if (body.tableSpace || arr(body.options).length || body.whereClause || arr(body.indexIncludingParams).length) chk.issue("index options (TABLESPACE, WITH, WHERE, INCLUDE) are not supported", at);
        for (const p of arr(body.indexParams)) {
          const ie = unwrap(p, "IndexElem");
          if (!ie || !ie.name || ie.expr) chk.issue("only plain column indexes are supported (no expressions)", at);
        }
        push("create_index", { table: String((body.relation as AstNode).relname) });
        break;
      }
      case "AlterTableStmt": {
        checkRangeVars(body.relation, at, chk);
        const cmds = arr(body.cmds).map((c) => unwrap(c, "AlterTableCmd")).filter((c): c is AstNode => !!c);
        if (body.objtype !== "OBJECT_TABLE") {
          unsupported.push(`line ${lineOf(buf, at)}: ALTER of a non-table object`);
          break;
        }
        if (cmds.length > 0 && cmds.every((c) => c.subtype === "AT_ChangeOwner")) {
          skippedKinds.add("ALTER TABLE … OWNER TO");
          break;
        }
        for (const c of cmds) {
          const sub = String(c.subtype);
          if (sub === "AT_AddConstraint") {
            const con = unwrap(c.def, "Constraint");
            if (!con) chk.issue("unsupported ALTER TABLE ADD", at);
            else {
              checkConstraint(con, at, chk, true);
              if (con.pktable) checkRangeVars(con.pktable, at, chk);
            }
          } else if (sub === "AT_ColumnDefault") checkExpr(c.def, at, chk, { allowColumns: false });
          else if (sub === "AT_SetNotNull") {
            /* fine */
          } else chk.issue(`ALTER TABLE action ${sub.replace("AT_", "")} is not supported`, at);
        }
        push("alter_table", { table: String((body.relation as AstNode).relname) });
        break;
      }
      case "InsertStmt": {
        checkRangeVars(body.relation, at, chk);
        const table = String((body.relation as AstNode).relname);
        const sel = unwrap(body.selectStmt, "SelectStmt");
        if (!sel || !arr(sel.valuesLists).length || arr(sel.targetList).length || arr(sel.fromClause).length || sel.whereClause || arr(sel.sortClause).length || sel.limitCount) {
          chk.issue("only INSERT … VALUES (…) with literal values is supported", at);
        }
        if (body.onConflictClause || body.returningClause || arr(body.returningList).length || body.withClause) chk.issue("INSERT options ON CONFLICT / RETURNING / WITH are not supported", at);
        if (body.override && body.override !== "OVERRIDING_NOT_SET" && body.override !== "OVERRIDING_SYSTEM_VALUE") chk.issue("OVERRIDING USER VALUE is not supported", at);
        if (sel) checkExpr(sel.valuesLists, at, chk, { allowColumns: false });
        if (!declared.has(table)) chk.issue(`INSERT into "${table}", which is not created earlier in this file`, at);
        const n = sel ? arr(sel.valuesLists).length : 0;
        rows += n;
        if (rows > limits.maxRows) throw new ImportError(`Too many rows (max ${limits.maxRows.toLocaleString("en-US")} across all tables).`);
        push("insert", { table, rows: n });
        break;
      }
      case "CreateSchemaStmt": {
        if (body.schemaname === "public" && body.if_not_exists) skippedKinds.add("CREATE SCHEMA IF NOT EXISTS public");
        else unsupported.push(`line ${lineOf(buf, at)}: ${UNSUPPORTED_LABELS.CreateSchemaStmt}`);
        break;
      }
      default:
        unsupported.push(`line ${lineOf(buf, at)}: ${UNSUPPORTED_LABELS[kind] ?? kind.replace(/Stmt$/, "")}`);
    }
  }

  const problems = [...unsupported, ...chk.issues];
  if (problems.length) throw new ImportError(UNSUPPORTED_SQL_MESSAGE, problems.slice(0, 25));
  if (declared.size === 0) throw new ImportError("The SQL file does not create any tables (CREATE TABLE statements are required).");
  if (declared.size > limits.maxTables) throw new ImportError(`Too many tables (${declared.size}; max ${limits.maxTables}).`);
  if (totalColumns > limits.maxTotalColumns) throw new ImportError(`Too many columns (${totalColumns}; max ${limits.maxTotalColumns}).`);
  for (const k of skippedKinds) warnings.push(`Ignored: ${k}`);

  return { statements: planned, comments, stats: { tables: [...declared.keys()], columns: totalColumns, rows, statements: planned.length }, warnings };
}
