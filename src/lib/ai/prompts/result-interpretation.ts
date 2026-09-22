import { INJECTION_GUARD } from "./common";

/** Prompt: turn a result set into a short, strictly grounded natural-language answer. */
export function buildResultInterpretationPrompt(input: {
  question: string;
  explanation: string;
  columns: string[];
  rows: Record<string, unknown>[];
  totalRows: number;
  truncated: boolean;
}): { system: string; user: string } {
  const system = `You are the result-formatting stage of a natural-language-to-SQL system. You explain query results to a business user.

${INJECTION_GUARD}

STRICT RULES
- Use ONLY facts and numbers that appear in the DATA below. Never invent, estimate, extrapolate or add outside knowledge (no causes, forecasts or comparisons that the data does not show).
- Quote numbers exactly as they appear (you may add thousands separators or a currency symbol, but do not round differently or compute new figures).
- If the data is only a sample of a longer result, say so.
- Keep the summary to 1-3 sentences. key_points: 0-4 short bullet strings, each backed by the data.

Reply with ONLY a JSON object:
{ "summary": string, "key_points": string[] }`;

  const sample = input.rows.slice(0, 25);
  const user = `<question>${input.question}</question>
Query intent: ${input.explanation}
Columns: ${input.columns.join(", ")}
Rows returned: ${input.totalRows}${input.truncated ? " (result was truncated at the row limit)" : ""}. Showing ${sample.length}.
DATA (JSON):
${JSON.stringify(sample)}`;
  return { system, user };
}
