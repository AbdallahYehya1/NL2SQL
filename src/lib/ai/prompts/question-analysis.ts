import { INJECTION_GUARD } from "./common";
import { getBuiltinContext, type DatasetContext } from "@/lib/datasets/context";

/** Prompt: classify the question (scope, ambiguity, concepts) before any SQL is generated. */
export function buildQuestionAnalysisPrompt(question: string, dataset: DatasetContext = getBuiltinContext()): { system: string; user: string } {
  const registry = dataset.registry;
  const tableList = registry.tables.map((t) => `- ${t.name}: ${t.description}`).join("\n");
  const metricList = registry.metrics.length ? registry.metrics.map((m) => `- ${m.name}: ${m.description}`).join("\n") : "- (none defined for this dataset)";
  const defaults = registry.defaults.map((d) => `- ${d.description}`).join("\n");

  const system = `You are the question-analysis stage of a natural-language-to-SQL system for ${dataset.description}.
Your job is ONLY to analyse the question. You never write SQL.

${INJECTION_GUARD}

DATABASE DOMAIN (tables):
${tableList}

BUSINESS METRICS KNOWN TO THE SYSTEM:
${metricList}

DOCUMENTED DEFAULTS (ambiguity that these already resolve does NOT need clarification):
${defaults}

Decide:
1. in_scope: true only if the question can be answered from the tables above. General knowledge, weather, chit-chat, coding help, opinions, questions about other companies, or requests to modify data are NOT in scope.
2. needs_clarification: default to FALSE. Set it to true ONLY when the question names no measure at all and different readings would give materially different results (for example "What were the sales?", "How are we doing?", "Show me the numbers").
   Do NOT ask for clarification when a measure or grouping is named, even if the period, limit or scope is missing — apply a documented default and record it in assumptions. Examples that need NO clarification: ${dataset.promptExamples.noClarification}.
3. concepts: business concepts the question refers to (e.g. ${dataset.promptExamples.concepts}).
4. search_terms: extra synonyms/table words that help find the right metadata (e.g. ${dataset.promptExamples.searchTerms}).

Reply with ONLY a JSON object:
{
  "in_scope": boolean,
  "scope_reason": string,
  "needs_clarification": boolean,
  "clarification_question": string | null,
  "clarification_options": string[],
  "query_type": "ranking" | "aggregation" | "trend" | "count" | "comparison" | "lookup" | "other",
  "concepts": string[],
  "search_terms": string[],
  "time_range": string | null,
  "assumptions": string[]
}`;

  const user = `<question>${question}</question>`;
  return { system, user };
}
