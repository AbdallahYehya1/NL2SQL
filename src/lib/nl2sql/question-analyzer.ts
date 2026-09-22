import { z } from "zod";
import type { AIProvider } from "@/lib/ai/provider";
import { buildQuestionAnalysisPrompt } from "@/lib/ai/prompts/question-analysis";
import type { LexicalIndex } from "@/lib/metadata/lexical";
import { LexicalIndex as Lex } from "@/lib/metadata/lexical";
import { getBuiltinContext, type DatasetContext } from "@/lib/datasets/context";
import { contentTokens } from "./text";
import type { LlmCallRecord, QuestionIntent, QueryType } from "@/lib/types";

/**
 * Stage 1 — question analysis. Deterministic rules run first (they are free and cannot be prompt-injected),
 * then one LLM call classifies scope / ambiguity and extracts concepts for retrieval.
 */

const topicList = (topics: string[]) => (topics.length > 1 ? `${topics.slice(0, -1).join(", ")}, or ${topics[topics.length - 1]}` : topics.join(""));

/** Refusal messages name the topics of the dataset being queried. */
export function outOfScopeMessage(dataset: DatasetContext = getBuiltinContext()): string {
  return `This question is outside the available database domain. Try asking about ${topicList(dataset.topics)}.`;
}
export function readOnlyMessage(dataset: DatasetContext = getBuiltinContext()): string {
  return `This assistant is read-only: it can answer questions about the data but cannot modify it. Try asking about ${topicList(dataset.topics)}.`;
}

export interface QuestionCheck {
  ok: boolean;
  question: string;
  code?: "EMPTY_QUESTION" | "QUESTION_TOO_LONG";
  message?: string;
}

export function checkQuestion(input: unknown, maxLength: number): QuestionCheck {
  const question = typeof input === "string" ? input.replace(/\s+/g, " ").trim() : "";
  if (!question) return { ok: false, question, code: "EMPTY_QUESTION", message: "Please type a question about the data." };
  if (question.length > maxLength) {
    return { ok: false, question, code: "QUESTION_TOO_LONG", message: `Questions are limited to ${maxLength} characters. Please shorten it.` };
  }
  return { ok: true, question };
}

const OFF_TOPIC = /\b(weather|forecast|joke|poem|song lyrics|recipe|translate|capital of|president|prime minister|news|bitcoin|crypto|horoscope|movie|football|write (me )?(a |an )?(code|essay|story|program|script)|who (is|was)|meaning of life|hello|hi there|how are you|thank(s| you))\b/i;
const DATA_INTENT = /\b(how many|how much|who|whom|whose|total|average|avg|sum|count|number of|top|most|least|highest|lowest|best|worst|per|percentage|percent|rate|trend|compare|growth|list|which|what (is|are|was|were))\b/i;
const WRITE_VERBS = "(?:delete|drop|truncate|insert|update|alter|erase|wipe|destroy)";
const SOFT_WRITE_VERBS = "(?:remove|modify|change|add|create|edit)";
const GENERIC_WRITE_TARGETS = ["table", "column", "row", "record", "data", "database", "user", "entry", "entries"];
const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const writeRequestCache = new WeakMap<DatasetContext, RegExp>();

/**
 * "add a new employee", "modify the price": a soft write verb followed by a generic noun (table, row, …) or by a table / column of
 * THIS dataset. Built from the dataset's own registry, so it works for any uploaded schema (no demo nouns baked in).
 */
function writeRequestPattern(dataset: DatasetContext): RegExp {
  let re = writeRequestCache.get(dataset);
  if (re) return re;
  const nouns = new Set<string>(GENERIC_WRITE_TARGETS);
  for (const t of dataset.registry.tables) {
    for (const name of [t.name, ...t.columns.map((c) => c.name)]) {
      const spaced = name.toLowerCase().replace(/_/g, " ");
      if (spaced.length < 3) continue;
      nouns.add(spaced);
      if (spaced.endsWith("ies")) nouns.add(`${spaced.slice(0, -3)}y`);
      else if (spaced.endsWith("s") && !spaced.endsWith("ss")) nouns.add(spaced.slice(0, -1));
      else nouns.add(`${spaced}s`);
    }
  }
  const alternation = [...nouns].sort((a, b) => b.length - a.length).map((n) => escapeRe(n).replace(/ /g, "[ _]")).join("|");
  re = new RegExp(`^\\s*(?:please\\s+|can you\\s+|could you\\s+)?(?:${WRITE_VERBS}\\b|${SOFT_WRITE_VERBS}\\s+(?:the\\s+|all\\s+|a\\s+|an\\s+|every\\s+)?(?:new\\s+|another\\s+)?(?:${alternation})\\b)`, "i");
  writeRequestCache.set(dataset, re);
  return re;
}
/** Write/DDL commands embedded anywhere in the text (prompt-injection style: "…; also drop table products"). */
const WRITE_INTENT_ANYWHERE = /\b(delete\s+from|drop\s+(table|schema|database|view)|truncate\s+table|insert\s+into|update\s+\w+\s+set|alter\s+table|grant\s+all)\b/i;
/** Unmistakably off-topic words: refused even if the sentence also mentions a table-like word. */
const STRONG_OFF_TOPIC = /\b(weather|forecast|joke|poem|song lyrics|recipe|horoscope|bitcoin|crypto|capital of|prime minister|president of)\b/i;
/** Number of distinct domain-vocabulary terms that must appear for lexical evidence to overrule a model verdict. */
const STRONG_DOMAIN_EVIDENCE = 2;
const LOOKS_LIKE_SQL = /^\s*(select|with|insert|update|delete|drop|alter|create|truncate|grant|revoke)\b[\s\S]*\b(from|table|into|set|database|schema|user)\b/i;

/** Words that carry no analytical content: a question made only of these (plus "sales") is too vague. */
const VAGUE_WORDS = new Set(["sale", "performance", "number", "stat", "statistic", "result", "data", "business", "overview", "summary", "report", "doing", "look", "figure", "do", "well"]);
const FILLER = new Set(["total", "overall", "recent", "recently", "latest", "today", "now", "year", "month", "week", "day", "time", "yesterday", "current", "so", "far", "ago"]);

export interface RuleDecision {
  decision: "proceed" | "out_of_scope" | "needs_clarification";
  intent: QuestionIntent;
}

const baseIntent = (over: Partial<QuestionIntent> = {}): QuestionIntent => ({
  inScope: true,
  needsClarification: false,
  queryType: "other",
  concepts: [],
  searchTerms: [],
  timeRange: null,
  assumptions: [],
  source: "rules",
  ...over,
});

function guessQueryType(q: string): QueryType {
  if (/\b(top|best|worst|highest|lowest|most|least|rank)\b/i.test(q)) return "ranking";
  if (/\b(trend|over time|monthly|weekly|daily|per month|by month|each month|yearly|growth|declin)/i.test(q)) return "trend";
  if (/\b(how many|number of|count)\b/i.test(q)) return "count";
  if (/\b(compare|versus|vs\.?|difference)\b/i.test(q)) return "comparison";
  if (/\b(average|avg|total|sum|percentage|percent|rate)\b/i.test(q)) return "aggregation";
  return "other";
}

/** Deterministic pre-checks. Never calls a model. */
export function analyzeWithRules(question: string, index: LexicalIndex, dataset: DatasetContext = getBuiltinContext()): RuleDecision {
  const q = question.trim();

  if (LOOKS_LIKE_SQL.test(q) || writeRequestPattern(dataset).test(q) || WRITE_INTENT_ANYWHERE.test(q)) {
    return {
      decision: "out_of_scope",
      intent: baseIntent({ inScope: false, scopeReason: "Request to write data or raw SQL instead of a data question.", queryType: "other" }),
    };
  }

  // bare "What were the sales?" style questions
  const content = contentTokens(q).filter((t) => !FILLER.has(t) && !/^\d+$/.test(t));
  if (content.length > 0 && content.every((t) => VAGUE_WORDS.has(t))) {
    return {
      decision: "needs_clarification",
      intent: baseIntent({
        needsClarification: true,
        clarificationQuestion: dataset.clarificationQuestion,
        clarificationOptions: dataset.clarificationOptions,
        scopeReason: "The question does not say which measure to report.",
      }),
    };
  }

  const query = Lex.buildQuery(q);
  const domainHits = index.domainHits(query);

  if (STRONG_OFF_TOPIC.test(q) || (domainHits.length === 0 && (OFF_TOPIC.test(q) || !DATA_INTENT.test(q)))) {
    return { decision: "out_of_scope", intent: baseIntent({ inScope: false, scopeReason: "No reference to the data in this dataset." }) };
  }

  return { decision: "proceed", intent: baseIntent({ queryType: guessQueryType(q), concepts: [] }) };
}

const LlmAnalysisSchema = z.object({
  in_scope: z.boolean(),
  scope_reason: z.string().optional().default(""),
  needs_clarification: z.boolean().optional().default(false),
  clarification_question: z.string().nullable().optional(),
  clarification_options: z.array(z.string()).optional().default([]),
  query_type: z.enum(["ranking", "aggregation", "trend", "count", "comparison", "lookup", "other"]).optional().default("other"),
  concepts: z.array(z.string()).optional().default([]),
  search_terms: z.array(z.string()).optional().default([]),
  time_range: z.string().nullable().optional(),
  assumptions: z.array(z.string()).optional().default([]),
});

export interface AnalysisOutcome {
  decision: "proceed" | "out_of_scope" | "needs_clarification";
  intent: QuestionIntent;
  llmCall?: LlmCallRecord;
}

/** True when the lexical index recognises a registry business metric in the question. */
export function namesKnownMeasure(question: string, index: LexicalIndex): boolean {
  const scores = index.search(Lex.buildQuery(question));
  for (const [id, score] of scores) if (id.startsWith("metric:") && score >= 0.5) return true;
  return false;
}

/** Rules first; if they say "proceed" and mode is llm, refine with a structured model call. */
export async function analyzeQuestion(
  question: string,
  deps: { provider: AIProvider; index: LexicalIndex; mode: "llm" | "rules"; dataset?: DatasetContext },
): Promise<AnalysisOutcome> {
  const dataset = deps.dataset ?? getBuiltinContext();
  const rules = analyzeWithRules(question, deps.index, dataset);
  if (rules.decision !== "proceed" || deps.mode === "rules") return rules;

  const { system, user } = buildQuestionAnalysisPrompt(question, dataset);
  const started = Date.now();
  const result = await deps.provider.generateStructured({ system, prompt: user, schema: LlmAnalysisSchema, schemaName: "question analysis", maxTokens: 700 });
  const llmCall: LlmCallRecord = { purpose: "analysis", model: deps.provider.model, latencyMs: Date.now() - started, ok: true };
  const a = result.data;

  const intent: QuestionIntent = {
    inScope: a.in_scope,
    scopeReason: a.scope_reason || undefined,
    needsClarification: a.in_scope && a.needs_clarification && !!a.clarification_question,
    clarificationQuestion: a.clarification_question ?? undefined,
    clarificationOptions: a.clarification_options.slice(0, 5),
    queryType: a.query_type,
    concepts: a.concepts.slice(0, 10),
    searchTerms: a.search_terms.slice(0, 12),
    timeRange: a.time_range ?? null,
    assumptions: a.assumptions.slice(0, 6),
    source: "llm",
  };
  // Lexical evidence beats a flaky model verdict. Small models sometimes refuse or over-ask on perfectly good questions
  // ("How many customers came from each acquisition channel?" → "out of scope"). When the question uses several
  // registry terms, the deterministic evidence wins and the decision is recorded in the trace.
  const strongEvidence = deps.index.domainHits(Lex.buildQuery(question)).length >= STRONG_DOMAIN_EVIDENCE;
  if (!intent.inScope && strongEvidence) {
    intent.inScope = true;
    intent.scopeReason = undefined;
    intent.assumptions.push("The model judged the question out of scope, but it uses several database terms, so it was treated as in scope.");
  }
  // Over-eager clarification: a named business measure, or strong domain evidence, means documented defaults apply.
  if (intent.needsClarification && (namesKnownMeasure(question, deps.index) || strongEvidence)) {
    intent.needsClarification = false;
    intent.assumptions.push("The question names a known measure or clear database terms, so documented defaults were applied instead of asking for clarification.");
  }
  if (!intent.inScope) return { decision: "out_of_scope", intent, llmCall };
  if (intent.needsClarification) return { decision: "needs_clarification", intent, llmCall };
  return { decision: "proceed", intent, llmCall };
}
