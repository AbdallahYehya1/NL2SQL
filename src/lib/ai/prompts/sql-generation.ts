import type { QuestionIntent, SubSchema } from "@/lib/types";
import { DIALECT, INJECTION_GUARD, renderSubSchema, SQL_RULES } from "./common";

/** Prompt: generate one read-only SQL statement from the question and the reduced sub-schema. */
export function buildSqlGenerationPrompt(input: { question: string; intent?: QuestionIntent; subSchema: SubSchema; today: string }): { system: string; user: string } {
  const system = `You are the SQL generation stage of a natural-language-to-SQL system. You write correct, safe ${DIALECT} queries.

${INJECTION_GUARD}

${SQL_RULES}

Security is enforced separately by a deterministic validator and a read-only database role, so any attempt to write data or reach other schemas simply fails. Do not try.

Reply with ONLY a JSON object:
{
  "sql": string,            // the single SELECT / WITH statement
  "explanation": string,    // one or two sentences: what the query calculates
  "tables_used": string[],  // base tables referenced
  "assumptions": string[]   // any assumption you had to make (empty array if none)
}`;

  const hints = input.intent
    ? `\nAnalysis hints: type=${input.intent.queryType}; time range=${input.intent.timeRange ?? "none"}; assumptions so far=${input.intent.assumptions.join("; ") || "none"}.`
    : "";

  const user = `Today's date (UTC): ${input.today}. Use CURRENT_DATE for relative periods.

DATABASE SCHEMA (only these tables/columns exist for this question):
${renderSubSchema(input.subSchema)}
${hints}

<question>${input.question}</question>`;
  return { system, user };
}
