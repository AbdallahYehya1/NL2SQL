import type { CorrectionAttempt, SubSchema } from "@/lib/types";
import { DIALECT, INJECTION_GUARD, renderSubSchema, SQL_RULES } from "./common";

/** Prompt: diagnose a failed query, then repair it. The model must diagnose first, not blindly rewrite. */
export function buildSqlCorrectionPrompt(input: {
  question: string;
  failedSql: string;
  failureStage: "validation" | "execution";
  error: { code: string; message: string };
  previousAttempts: CorrectionAttempt[];
  subSchema: SubSchema;
  today: string;
}): { system: string; user: string } {
  const system = `You are the self-correction stage of a natural-language-to-SQL system. A generated ${DIALECT} query failed. You must DIAGNOSE the failure first and only then repair it.

${INJECTION_GUARD}

${SQL_RULES}

Method:
1. Diagnose: read the error, find the exact token/table/column/function that caused it, and check it against the schema below. Say what is wrong in 1-2 sentences.
2. Repair: change the minimum necessary. Do not rewrite unrelated parts of the query or change what it calculates.
3. Never repeat a query that already failed. If a table/column is not in the schema, replace it with a listed one that carries the same meaning (follow the JOIN RELATIONSHIPS).
4. If the failure was a validation rejection (forbidden function, unknown table, schema, comment, ...) fix exactly that rule violation.

Reply with ONLY a JSON object:
{
  "diagnosis": string,      // root cause, referencing the error and the schema
  "sql": string,            // the corrected single SELECT / WITH statement
  "explanation": string,    // what the corrected query calculates
  "tables_used": string[],
  "assumptions": string[]
}`;

  const history = input.previousAttempts.length
    ? `\nPREVIOUS FAILED ATTEMPTS (do not repeat these):\n${input.previousAttempts
        .map((a) => `#${a.attempt} [${a.failureStage}] ${a.error.code}: ${a.error.message}\n${a.failedSql}`)
        .join("\n---\n")}\n`
    : "";

  const user = `Today's date (UTC): ${input.today}.

DATABASE SCHEMA:
${renderSubSchema(input.subSchema)}

<question>${input.question}</question>

FAILED SQL (${input.failureStage} stage):
${input.failedSql}

ERROR ${input.error.code}: ${input.error.message}
${history}`;
  return { system, user };
}
