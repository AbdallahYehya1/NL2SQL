import type pg from "pg";
import { getConfig, type AppConfig } from "@/lib/config";
import { correctSql } from "@/lib/ai/correction-agent";
import { getProvider, ProviderError, type AIProvider } from "@/lib/ai/provider";
import { formatResult } from "@/lib/ai/result-formatter";
import { generateSql } from "@/lib/ai/sql-generator";
import { executeQuery } from "@/lib/database/executor";
import { toValidatedSql, validateSql } from "@/lib/database/validator";
import { getAdminPool, isDatabaseConfigured } from "@/lib/database/client";
import { DEMO_DATASET_ID, getBuiltinContext, type DatasetContext } from "@/lib/datasets/context";
import { DatasetError, loadDatasetContext } from "@/lib/datasets/store";
import { PgRunStore, type RunContext, type RunStore } from "@/lib/history/store";
import { analyzeQuestion, checkQuestion, outOfScopeMessage, readOnlyMessage } from "./question-analyzer";
import { getLexicalIndex, retrieveMetadata } from "./metadata-retriever";
import { route } from "./router";
import { buildSubSchema, summariseSubSchema } from "./sub-schema-builder";
import type {
  AgentTrace,
  CorrectionAttempt,
  ErrorCode,
  ExecutionResult,
  FormattedResult,
  GeneratedSql,
  QueryResponse,
  QuestionIntent,
  RoutingResult,
  RunStatus,
  SubSchema,
  ValidationResult,
} from "@/lib/types";

/**
 * The central orchestration service. It owns the explicit pipeline state and calls each stage in order:
 *
 *   analyze → route (retrieve metadata) → build sub-schema → generate SQL →
 *   [ validate → execute → (on failure) self-correct ]×N → format result → record trace
 *
 * Every stage is a small exported function so it can be tested independently.
 */

/** Explicit state carried through the pipeline (see docs/AI_PIPELINE.md). */
export interface QueryExecutionState {
  question: string;
  intent?: QuestionIntent;
  routing?: RoutingResult;
  subSchema?: SubSchema;
  generated?: GeneratedSql;
  /** The SQL currently under consideration (changes with every correction). */
  currentSql?: string;
  validation?: ValidationResult;
  execution?: ExecutionResult;
  correctionAttempts: CorrectionAttempt[];
  attempts: number;
  formatted?: FormattedResult;
  trace: AgentTrace;
  /** The dataset every stage runs against. */
  dataset?: { id: string; name: string };
  /** Stage currently running (used to attribute a failed model call in the trace). */
  activeStage?: string;
  activeCallStartedAt?: number;
}

export interface OrchestratorDeps {
  provider: AIProvider;
  config: AppConfig;
  /** Dataset (schema + metadata + read-only role) the question runs against. Default: the built-in demo. */
  dataset?: DatasetContext;
  /** Pool for vector search + persistence. Optional so the pipeline can run without a history store. */
  pool?: pg.Pool;
  store?: RunStore;
  useVectorSearch?: boolean;
  now?: () => Date;
  execute?: typeof executeQuery;
}

export class PipelineError extends Error {
  constructor(
    readonly code: ErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "PipelineError";
  }
}

/** Validator codes that mean "the model tried to write/lock" — rejected outright, never "corrected". */
const FATAL_VALIDATION_CODES = new Set(["WRITE_OPERATION", "LOCKING_CLAUSE", "SELECT_INTO"]);

// ───────────────────────── helpers ─────────────────────────
export function newState(question: string): QueryExecutionState {
  return { question, correctionAttempts: [], attempts: 0, trace: { question, attempts: [], corrections: [], llmCalls: [], timings: [] } };
}

async function timed<T>(state: QueryExecutionState, stage: string, fn: () => Promise<T> | T): Promise<T> {
  const t = Date.now();
  state.activeStage = stage;
  state.activeCallStartedAt = t;
  try {
    return await fn();
  } finally {
    state.trace.timings.push({ stage, ms: Date.now() - t });
  }
}

const dsOf = (deps: OrchestratorDeps): DatasetContext => deps.dataset ?? getBuiltinContext();
const today = (deps: OrchestratorDeps) => (deps.now?.() ?? new Date()).toISOString().slice(0, 10);

export function mapProviderError(err: unknown): PipelineError {
  if (err instanceof PipelineError) return err;
  if (err instanceof ProviderError) return new PipelineError(err.code, err.message);
  return new PipelineError("INTERNAL", "Something went wrong while processing the question.");
}

// ───────────────────────── stages ─────────────────────────
export async function stageAnalyze(state: QueryExecutionState, deps: OrchestratorDeps) {
  const outcome = await timed(state, "analysis", () => analyzeQuestion(state.question, { provider: deps.provider, index: getLexicalIndex(dsOf(deps)), mode: deps.config.analysisMode, dataset: dsOf(deps) }));
  state.intent = outcome.intent;
  state.trace.intent = outcome.intent;
  if (outcome.llmCall) state.trace.llmCalls.push(outcome.llmCall);
  return outcome.decision;
}

export async function stageRoute(state: QueryExecutionState, deps: OrchestratorDeps) {
  const retrieval = await timed(state, "retrieval", () =>
    retrieveMetadata(state.question, {
      dataset: dsOf(deps),
      intent: state.intent,
      vector: deps.useVectorSearch && deps.pool ? { provider: deps.provider, pool: deps.pool } : undefined,
    }),
  );
  state.routing = route(retrieval.items, retrieval.method, retrieval.vectorUnavailableReason, dsOf(deps));
  state.trace.routing = state.routing;
  if (state.routing.selectedTables.length === 0) {
    throw new PipelineError("OUT_OF_SCOPE", outOfScopeMessage(dsOf(deps)));
  }
}

export function stageBuildSubSchema(state: QueryExecutionState, dataset: DatasetContext = getBuiltinContext()) {
  const t = Date.now();
  state.subSchema = buildSubSchema(state.routing!, undefined, dataset);
  state.trace.subSchema = summariseSubSchema(state.subSchema);
  state.trace.timings.push({ stage: "sub_schema", ms: Date.now() - t });
}

export async function stageGenerate(state: QueryExecutionState, deps: OrchestratorDeps) {
  const { generated, llmCall } = await timed(state, "sql_generation", () =>
    generateSql(deps.provider, { question: state.question, intent: state.intent, subSchema: state.subSchema!, today: today(deps) }),
  );
  state.generated = generated;
  state.currentSql = generated.sql;
  state.trace.llmCalls.push(llmCall);
}

/**
 * Validate → execute → self-correct loop, bounded by config.limits.maxSqlAttempts.
 * Returns when a query has executed successfully; throws PipelineError when the bound is exhausted.
 */
export async function stageExecuteWithCorrection(state: QueryExecutionState, deps: OrchestratorDeps) {
  const maxAttempts = deps.config.limits.maxSqlAttempts;
  const execute = deps.execute ?? executeQuery;
  const triedSql = new Set<string>();

  for (;;) {
    state.attempts += 1;
    const attempt = state.attempts;
    const sql = state.currentSql!;
    triedSql.add(normaliseSql(sql));

    // 1. validate (deterministic)
    const validation = await timed(state, `validate#${attempt}`, () => validateSql(sql, dsOf(deps)));
    state.validation = validation;
    const traceAttempt: AgentTrace["attempts"][number] = { attempt, sql, validation: { valid: validation.valid, issues: validation.issues } };
    state.trace.attempts.push(traceAttempt);

    let failure: { stage: "validation" | "execution"; code: string; message: string; fatal?: PipelineError } | undefined;

    if (!validation.valid) {
      const fatal = validation.issues.find((i) => FATAL_VALIDATION_CODES.has(i.code));
      failure = {
        stage: "validation",
        code: validation.issues[0].code,
        message: validation.issues.map((i) => i.message).join(" "),
        fatal: fatal ? new PipelineError("SQL_REJECTED", "The generated query tried to modify data or use a forbidden operation and was blocked. Only read-only questions are supported.") : undefined,
      };
    } else {
      // 2. execute (read-only, time- and row-limited)
      const execution = await timed(state, `execute#${attempt}`, () => execute({ sql: toValidatedSql(validation), dataset: dsOf(deps), maxRows: deps.config.limits.maxRows, timeoutMs: deps.config.limits.queryTimeoutMs }));
      state.execution = execution;
      if (execution.success) {
        traceAttempt.execution = { success: true, rowCount: execution.rowCount, executionTimeMs: execution.executionTimeMs };
        const last = state.correctionAttempts[state.correctionAttempts.length - 1];
        if (last && !last.outcome) last.outcome = "success";
        return;
      }
      traceAttempt.execution = { success: false, executionTimeMs: execution.executionTimeMs, error: { code: execution.error.code, message: execution.error.detail ?? execution.error.message } };
      failure = {
        stage: "execution",
        code: execution.error.code,
        message: execution.error.detail ?? execution.error.message,
        fatal: execution.error.category === "connection" ? new PipelineError("DATABASE_UNAVAILABLE", execution.error.message) : undefined,
      };
    }

    const prev = state.correctionAttempts[state.correctionAttempts.length - 1];
    if (prev && !prev.outcome) prev.outcome = "failed";
    if (failure.fatal) throw failure.fatal;

    const record: CorrectionAttempt = { attempt, failedSql: sql, failureStage: failure.stage, error: { code: failure.code, message: failure.message } };
    state.correctionAttempts.push(record);
    state.trace.corrections = state.correctionAttempts;

    if (attempt >= maxAttempts) {
      record.outcome = "not_run";
      throw failure.stage === "validation"
        ? new PipelineError("SQL_REJECTED", `The generated query could not be made valid after ${attempt} attempts: ${failure.message}`)
        : new PipelineError("SQL_EXECUTION_FAILED", `The query could not be executed successfully after ${attempt} attempts.`);
    }

    // 3. self-correction: diagnose, then repair
    const { diagnosis, generated, llmCall } = await timed(state, `correction#${attempt}`, () =>
      correctSql(deps.provider, {
        question: state.question,
        failedSql: sql,
        failureStage: failure!.stage,
        error: { code: failure!.code, message: failure!.message },
        previousAttempts: state.correctionAttempts.slice(0, -1),
        subSchema: state.subSchema!,
        today: today(deps),
      }),
    );
    state.trace.llmCalls.push(llmCall);
    record.diagnosis = diagnosis;
    record.correctedSql = generated.sql;
    record.correctionExplanation = generated.explanation;
    state.generated = generated;
    state.currentSql = generated.sql;

    if (triedSql.has(normaliseSql(generated.sql))) {
      record.outcome = "not_run";
      throw new PipelineError("SQL_EXECUTION_FAILED", "The correction agent proposed a query that had already failed, so the attempt was stopped.");
    }
  }
}

const normaliseSql = (s: string) => s.replace(/\s+/g, " ").replace(/;\s*$/, "").trim().toLowerCase();

export async function stageFormat(state: QueryExecutionState, deps: OrchestratorDeps) {
  const exec = state.execution;
  if (!exec || !exec.success) return;
  const { formatted, llmCall } = await timed(state, "formatting", () =>
    formatResult({
      question: state.question,
      explanation: state.generated?.explanation ?? "",
      columns: exec.columns,
      rows: exec.rows,
      truncated: exec.truncated,
      provider: deps.provider,
      // Privacy: result ROWS are only ever sent to the model for the built-in synthetic demo. Rows of an uploaded dataset never leave
      // the database/app: their summary is always the deterministic one built locally from the rows.
      mode: dsOf(deps).sourceType === "builtin" ? deps.config.summaryMode : "deterministic",
    }),
  );
  state.formatted = formatted;
  if (llmCall) state.trace.llmCalls.push(llmCall);
}

/** A model call that threw (rate limit, bad output, ...) is still part of the trace. */
function recordFailedModelCall(state: QueryExecutionState, err: unknown) {
  if (!(err instanceof ProviderError)) return;
  const stage = state.activeStage ?? "";
  const purpose = stage.startsWith("analysis")
    ? "analysis"
    : stage.startsWith("sql_generation")
      ? "sql_generation"
      : stage.startsWith("correction")
        ? "sql_correction"
        : undefined;
  if (!purpose) return;
  state.trace.llmCalls.push({ purpose, model: state.trace.model ?? "", latencyMs: Date.now() - (state.activeCallStartedAt ?? Date.now()), ok: false, error: err.message.slice(0, 200) });
}

// ───────────────────────── response building ─────────────────────────
function baseResponse(state: QueryExecutionState, started: number, status: RunStatus, answer: string): QueryResponse {
  return {
    success: status === "success" || status === "no_results",
    status,
    dataset: state.dataset,
    answer,
    keyPoints: [],
    tablesUsed: [],
    columnsUsed: [],
    columns: [],
    rows: [],
    rowCount: 0,
    truncated: false,
    totalLatencyMs: Date.now() - started,
    attempts: state.attempts,
    corrections: state.correctionAttempts,
    trace: state.trace,
  };
}

function successResponse(state: QueryExecutionState, started: number): QueryResponse {
  const exec = state.execution as Extract<ExecutionResult, { success: true }>;
  const formatted = state.formatted!;
  const status: RunStatus = exec.rowCount === 0 ? "no_results" : "success";
  const res = baseResponse(state, started, status, formatted.summary);
  Object.assign(res, {
    keyPoints: formatted.keyPoints,
    sql: state.validation?.sql ?? state.currentSql,
    explanation: state.generated?.explanation,
    tablesUsed: state.validation?.tablesUsed ?? [],
    columnsUsed: state.validation?.columnsUsed ?? [],
    columns: formatted.columns,
    rows: formatted.rows,
    rowCount: exec.rowCount,
    truncated: exec.truncated,
    executionTimeMs: exec.executionTimeMs,
  });
  state.trace.finalAnswer = formatted.summary;
  return res;
}

function errorResponse(state: QueryExecutionState, started: number, err: PipelineError): QueryResponse {
  const res = baseResponse(state, started, "error", err.message);
  res.error = { code: err.code, message: err.message };
  res.sql = state.currentSql;
  state.trace.error = { code: err.code, message: err.message };
  return res;
}

// ───────────────────────── public entry point ─────────────────────────
/** Accepts a plain question (built-in demo dataset) or `{ question, datasetId }`. */
export interface QuestionInput {
  question: unknown;
  datasetId: string;
}

export async function processQuestion(input: unknown, ctx: RunContext = {}, overrides: Partial<OrchestratorDeps> = {}): Promise<QueryResponse> {
  const started = Date.now();
  const config = overrides.config ?? getConfig();
  const structured = typeof input === "object" && input !== null && "question" in input ? (input as Partial<QuestionInput>) : undefined;
  const check = checkQuestion(structured ? structured.question : input, config.limits.maxQuestionLength);
  const state = newState(check.question);

  // Failures before any real work (empty / too long) are not recorded.
  if (!check.ok) {
    return errorResponse(state, started, new PipelineError(check.code!, check.message!));
  }

  let pool = overrides.pool;
  if (!pool && isDatabaseConfigured()) pool = getAdminPool();

  // ── resolve the dataset EXPLICITLY. Nothing below has a default dataset except the documented plain-string form. ──
  const datasetId = overrides.dataset?.id ?? structured?.datasetId ?? ctx.datasetId ?? DEMO_DATASET_ID;
  let dataset: DatasetContext;
  try {
    if (overrides.dataset) dataset = overrides.dataset;
    else if (datasetId === DEMO_DATASET_ID) dataset = getBuiltinContext();
    else if (!pool) throw new DatasetError("not_found", "Dataset not found.");
    else dataset = await loadDatasetContext(pool, datasetId, ctx.sessionId);
  } catch (err) {
    const code = err instanceof DatasetError && err.code === "not_ready" ? "DATASET_NOT_READY" : "DATASET_NOT_FOUND";
    return errorResponse(state, started, new PipelineError(code, err instanceof DatasetError ? err.message : "Dataset not found."));
  }
  state.dataset = { id: dataset.id, name: dataset.name };
  state.trace.datasetId = dataset.id;

  let deps: OrchestratorDeps;
  let response: QueryResponse;
  try {
    deps = {
      provider: overrides.provider ?? getProvider(),
      config,
      dataset,
      pool,
      store: overrides.store ?? (pool ? new PgRunStore(pool) : undefined),
      useVectorSearch: overrides.useVectorSearch ?? Boolean(pool),
      now: overrides.now,
      execute: overrides.execute,
    };
    state.trace.provider = deps.provider.name;
    state.trace.model = deps.provider.model;

    const decision = await stageAnalyze(state, deps);
    if (decision === "out_of_scope") {
      const isWrite = /read-only|write|modify|raw SQL/i.test(state.intent?.scopeReason ?? "");
      response = baseResponse(state, started, "out_of_scope", isWrite ? readOnlyMessage(dataset) : outOfScopeMessage(dataset));
      state.trace.finalAnswer = response.answer;
    } else if (decision === "needs_clarification") {
      const question = state.intent!.clarificationQuestion ?? "Could you clarify which measure you mean?";
      response = baseResponse(state, started, "needs_clarification", question);
      response.clarification = { question, options: state.intent!.clarificationOptions ?? [] };
      state.trace.finalAnswer = question;
    } else {
      await stageRoute(state, deps);
      stageBuildSubSchema(state, dataset);
      await stageGenerate(state, deps);
      await stageExecuteWithCorrection(state, deps);
      await stageFormat(state, deps);
      response = successResponse(state, started);
    }
  } catch (err) {
    const pe = mapProviderError(err);
    recordFailedModelCall(state, err);
    if (pe.code === "OUT_OF_SCOPE") {
      response = baseResponse(state, started, "out_of_scope", pe.message);
      state.trace.finalAnswer = pe.message;
    } else {
      if (pe.code === "INTERNAL") console.error("[nl2sql] unexpected pipeline error:", err);
      response = errorResponse(state, started, pe);
    }
  }

  response.totalLatencyMs = Date.now() - started;
  state.trace.timings.push({ stage: "total", ms: response.totalLatencyMs });
  response.attempts = state.attempts;
  response.corrections = state.correctionAttempts;

  // Persist the run + trace. A storage failure must never fail the user's request.
  const store = overrides.store ?? (pool ? new PgRunStore(pool) : undefined);
  if (store) {
    try {
      response.runId = await store.save(response, ctx, { provider: state.trace.provider, model: state.trace.model });
    } catch (err) {
      console.error("[nl2sql] failed to record query run:", (err as Error).message);
    }
  }
  return response;
}
