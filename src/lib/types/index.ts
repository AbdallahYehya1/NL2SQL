/** Shared domain types for the NL2SQL pipeline. */

// ───────────────────────── Metadata registry ─────────────────────────
export interface ColumnMeta {
  name: string;
  type: string;
  description: string;
  /** How the business uses this column (definitions, units, caveats). */
  businessMeaning?: string;
  sampleValues?: string[];
  synonyms?: string[];
  primaryKey?: boolean;
  /** Foreign-key target. Relationships are derived from this single source of truth. */
  references?: { table: string; column: string };
  /** Always include in the sub-schema when the table is selected (e.g. display names, key measures). */
  core?: boolean;
  /** false when the column is NOT NULL (uploaded datasets: taken from the real catalog). */
  nullable?: boolean;
  /** Where the description came from. Structure (names, types, keys) always comes from the database itself. */
  descriptionSource?: DescriptionSource;
}

/** database = COMMENT ON in the upload, generated = deterministic template, llm = model-written (never overrides structure). */
export type DescriptionSource = "curated" | "database" | "generated" | "llm";

export interface TableMeta {
  name: string;
  description: string;
  businessMeaning?: string;
  synonyms: string[];
  columns: ColumnMeta[];
  primaryKey: string[];
  /** Grouping used in docs and the UI ("uploaded" for user datasets). */
  domain: string;
  rowCount?: number;
  descriptionSource?: DescriptionSource;
}

export interface Relationship {
  fromTable: string;
  fromColumn: string;
  toTable: string;
  toColumn: string;
  description: string;
}

export interface MetricMeta {
  name: string;
  description: string;
  synonyms: string[];
  /** Precise business definition given to the SQL generator (SQL-flavoured, dialect-neutral wording). */
  definition: string;
  tables: string[];
  columns: { table: string; column: string }[];
}

export interface MetadataRegistry {
  tables: TableMeta[];
  relationships: Relationship[];
  metrics: MetricMeta[];
  /** Documented defaults applied when a question is under-specified. */
  defaults: DefaultRule[];
}

/**
 * A documented default. `always` defaults are always given to the SQL generator; the others only when the sub-schema
 * contains one of `whenTables` or a matched metric is in `whenMetrics`. Keeps the pipeline free of hard-coded table names.
 */
export interface DefaultRule {
  name: string;
  description: string;
  always?: boolean;
  whenTables?: string[];
  whenMetrics?: string[];
}

export type MetadataItemKind = "table" | "column" | "metric";

/** A retrievable unit of metadata (one embedding / one lexical document). */
export interface MetadataItem {
  id: string; // table:orders | column:orders.status | metric:revenue
  kind: MetadataItemKind;
  table?: string;
  column?: string;
  metric?: string;
  /** Text used for both lexical matching and embedding. */
  text: string;
  /** Name-like terms (weighted higher in lexical scoring). */
  names: string[];
}

// ───────────────────────── Question analysis ─────────────────────────
export type QueryType = "ranking" | "aggregation" | "trend" | "count" | "comparison" | "lookup" | "other";

export interface QuestionIntent {
  inScope: boolean;
  scopeReason?: string;
  needsClarification: boolean;
  clarificationQuestion?: string;
  clarificationOptions?: string[];
  queryType: QueryType;
  /** Business concepts referenced (e.g. "revenue", "customers"). */
  concepts: string[];
  /** Extra retrieval terms (synonyms, expansions) proposed by the analyzer. */
  searchTerms: string[];
  timeRange?: string | null;
  /** Explicit defaults applied to resolve minor ambiguity. */
  assumptions: string[];
  source: "rules" | "llm";
}

// ───────────────────────── Retrieval / routing ─────────────────────────
export interface RetrievedItem {
  id: string;
  kind: MetadataItemKind;
  table?: string;
  column?: string;
  metric?: string;
  score: number;
  lexicalScore: number;
  vectorScore?: number;
}

export interface RoutingResult {
  method: "hybrid" | "lexical";
  /** Why vector search was not used (when method === "lexical"). */
  vectorUnavailableReason?: string;
  items: RetrievedItem[];
  tableScores: { table: string; score: number }[];
  selectedTables: string[];
  /** Tables added by relationship expansion (join bridges). */
  bridgeTables: string[];
  matchedMetrics: string[];
}

// ───────────────────────── Sub-schema ─────────────────────────
export interface SubSchemaColumn {
  name: string;
  type: string;
  description: string;
  businessMeaning?: string;
  sampleValues?: string[];
  primaryKey?: boolean;
  references?: { table: string; column: string };
}

export interface SubSchemaTable {
  name: string;
  description: string;
  columns: SubSchemaColumn[];
  /** true when only join-key columns were included (bridge table). */
  bridgeOnly: boolean;
}

export interface SubSchema {
  tables: SubSchemaTable[];
  relationships: Relationship[];
  metrics: { name: string; description: string; definition: string }[];
  defaults: { name: string; description: string }[];
}

// ───────────────────────── SQL generation / validation / execution ─────────────────────────
export interface GeneratedSql {
  sql: string;
  explanation: string;
  tablesUsed: string[];
  assumptions: string[];
}

export interface ValidationIssue {
  code:
    | "EMPTY"
    | "PARSE_ERROR"
    | "MULTIPLE_STATEMENTS"
    | "NOT_SELECT"
    | "COMMENT_NOT_ALLOWED"
    | "WRITE_OPERATION"
    | "LOCKING_CLAUSE"
    | "SELECT_INTO"
    | "UNKNOWN_TABLE"
    | "FORBIDDEN_SCHEMA"
    | "FORBIDDEN_FUNCTION"
    | "UNKNOWN_COLUMN"
    | "TOO_LONG"
    | "TOO_COMPLEX"
    | "SYSTEM_ACCESS";
  message: string;
}

export interface ValidationResult {
  valid: boolean;
  issues: ValidationIssue[];
  /** Base tables referenced (registry names). */
  tablesUsed: string[];
  /** "table.column" pairs that could be resolved to a registry column. */
  columnsUsed: string[];
  /** SQL that is safe to execute (comments/trailing semicolon removed). Only set when valid. */
  sql?: string;
}

declare const validatedBrand: unique symbol;
/** SQL that passed the validator. The executor only accepts this type. */
export type ValidatedSql = string & { readonly [validatedBrand]: true };

export type DbErrorCategory =
  | "syntax"
  | "undefined_column"
  | "undefined_table"
  | "undefined_function"
  | "type_mismatch"
  | "permission"
  | "timeout"
  | "data_exception"
  | "connection"
  | "unknown";

export interface ExecutionError {
  code: string; // SQLSTATE or internal code
  category: DbErrorCategory;
  /** Safe to show to users. */
  message: string;
  /** Sanitised database message, fed to the correction agent and trace (never contains connection details). */
  detail?: string;
}

export type ExecutionResult =
  | { success: true; columns: string[]; rows: Record<string, unknown>[]; rowCount: number; truncated: boolean; executionTimeMs: number }
  | { success: false; error: ExecutionError; executionTimeMs: number };

// ───────────────────────── Self-correction ─────────────────────────
export interface CorrectionAttempt {
  /** 1-based attempt number of the SQL that FAILED. */
  attempt: number;
  failedSql: string;
  failureStage: "validation" | "execution";
  error: { code: string; message: string };
  diagnosis?: string;
  correctedSql?: string;
  correctionExplanation?: string;
  /** Outcome of the corrected SQL (filled in by the next loop iteration). */
  outcome?: "success" | "failed" | "not_run";
}

// ───────────────────────── Result formatting ─────────────────────────
export interface FormattedResult {
  summary: string;
  keyPoints: string[];
  columns: string[];
  rows: Record<string, unknown>[];
  /** "llm" when the model summary passed the grounding check, otherwise the deterministic fallback. */
  summarySource: "llm" | "deterministic";
}

// ───────────────────────── Trace & response ─────────────────────────
export type RunStatus = "success" | "no_results" | "out_of_scope" | "needs_clarification" | "error";

export interface StageTiming {
  stage: string;
  ms: number;
}

export interface LlmCallRecord {
  purpose: "analysis" | "sql_generation" | "sql_correction" | "result_formatting";
  model: string;
  latencyMs: number;
  ok: boolean;
  error?: string;
}

export interface AgentTrace {
  question: string;
  datasetId?: string;
  intent?: QuestionIntent;
  routing?: RoutingResult;
  subSchema?: { tables: string[]; columns: string[]; relationships: string[]; metrics: string[] };
  attempts: {
    attempt: number;
    sql: string;
    validation: { valid: boolean; issues: ValidationIssue[] };
    execution?: { success: boolean; rowCount?: number; executionTimeMs: number; error?: { code: string; message: string } };
  }[];
  corrections: CorrectionAttempt[];
  llmCalls: LlmCallRecord[];
  timings: StageTiming[];
  provider?: string;
  model?: string;
  finalAnswer?: string;
  error?: { code: string; message: string };
}

export type ErrorCode =
  | "EMPTY_QUESTION"
  | "QUESTION_TOO_LONG"
  | "OUT_OF_SCOPE"
  | "NEEDS_CLARIFICATION"
  | "DATASET_NOT_FOUND"
  | "DATASET_NOT_READY"
  | "PROVIDER_NOT_CONFIGURED"
  | "PROVIDER_AUTH"
  | "PROVIDER_RATE_LIMIT"
  | "PROVIDER_UNAVAILABLE"
  | "PROVIDER_BAD_OUTPUT"
  | "SQL_GENERATION_FAILED"
  | "SQL_REJECTED"
  | "SQL_EXECUTION_FAILED"
  | "DATABASE_UNAVAILABLE"
  | "RATE_LIMITED"
  | "INTERNAL";

export interface QueryResponse {
  success: boolean;
  status: RunStatus;
  runId?: string;
  /** The dataset this answer was produced from (every query runs against exactly one dataset). */
  dataset?: { id: string; name: string };
  answer: string;
  keyPoints: string[];
  sql?: string;
  explanation?: string;
  tablesUsed: string[];
  columnsUsed: string[];
  columns: string[];
  rows: Record<string, unknown>[];
  rowCount: number;
  truncated: boolean;
  executionTimeMs?: number;
  totalLatencyMs: number;
  attempts: number;
  corrections: CorrectionAttempt[];
  clarification?: { question: string; options: string[] };
  error?: { code: ErrorCode; message: string };
  trace: AgentTrace;
}
