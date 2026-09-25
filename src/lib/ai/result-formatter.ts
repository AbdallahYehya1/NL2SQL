import { z } from "zod";
import { ProviderError, type AIProvider } from "./provider";
import { buildResultInterpretationPrompt } from "./prompts/result-interpretation";
import type { FormattedResult, LlmCallRecord, RateLimitInfo } from "@/lib/types";

export const NO_RESULTS_MESSAGE = "No matching records were found.";

const SummarySchema = z.object({
  summary: z.string().min(1),
  key_points: z.array(z.string()).optional().default([]),
});

const nf = new Intl.NumberFormat("en-US", { maximumFractionDigits: 2 });

const fmtValue = (v: unknown): string => {
  if (v === null || v === undefined) return "n/a";
  if (typeof v === "number") return nf.format(v);
  if (typeof v === "boolean") return v ? "yes" : "no";
  const iso = String(v).match(/^(\d{4}-\d{2}-\d{2})T00:00:00(?:\.000)?Z$/);
  return iso ? iso[1] : String(v);
};

const isDateLike = (v: unknown) => typeof v === "string" && /^\d{4}-\d{2}/.test(v);

const pretty = (col: string) => col.replace(/_/g, " ");

/** Summary built only from the returned rows. Always available; used when the model is off or fails the check. */
export function deterministicSummary(columns: string[], rows: Record<string, unknown>[], truncated: boolean): { summary: string; keyPoints: string[] } {
  if (rows.length === 0) return { summary: NO_RESULTS_MESSAGE, keyPoints: [] };
  const first = rows[0];
  const numeric = columns.filter((c) => typeof first[c] === "number");
  const label = columns.find((c) => typeof first[c] === "string");

  if (rows.length === 1) {
    const parts = columns.map((c) => `${pretty(c)}: ${fmtValue(first[c])}`);
    return { summary: columns.length === 1 ? `The result is ${fmtValue(first[columns[0]])} (${pretty(columns[0])}).` : `Result — ${parts.join(", ")}.`, keyPoints: [] };
  }

  const limitNote = truncated ? " (the result was cut off at the row limit)" : "";
  if (!label || numeric.length === 0) return { summary: `The query returned ${rows.length} rows${limitNote}.`, keyPoints: [] };

  // Everything below only restates values that are present in the rows (first / last / highest / lowest).
  const m = numeric[0];
  const last = rows[rows.length - 1];
  const withValue = rows.filter((r) => typeof r[m] === "number");
  const highest = withValue.reduce((a, r) => ((r[m] as number) > (a[m] as number) ? r : a), withValue[0]);
  const lowest = withValue.reduce((a, r) => ((r[m] as number) < (a[m] as number) ? r : a), withValue[0]);
  const at = (r: Record<string, unknown>) => `${fmtValue(r[m])} (${fmtValue(r[label])})`;
  const keyPoints: string[] = [];
  let summary: string;

  if (rows.every((r) => isDateLike(r[label]))) {
    summary = `${rows.length} periods${limitNote}: ${pretty(m)} went from ${at(first)} to ${at(last)}. Highest: ${at(highest)}; lowest: ${at(lowest)}.`;
    keyPoints.push(`Highest ${pretty(m)}: ${at(highest)}`, `Lowest ${pretty(m)}: ${at(lowest)}`);
  } else {
    summary = `The query returned ${rows.length} rows${limitNote}. The first row is ${fmtValue(first[label])} with ${pretty(m)} ${fmtValue(first[m])}.`;
    keyPoints.push(`${fmtValue(first[label])}: ${pretty(m)} ${fmtValue(first[m])}`);
    if (rows.length > 2) keyPoints.push(`${fmtValue(last[label])}: ${pretty(m)} ${fmtValue(last[m])} (last row)`);
  }
  return { summary, keyPoints };
}

/** All numeric tokens present anywhere in the data (numbers and digits inside strings/dates). */
export function numbersInData(rows: Record<string, unknown>[]): number[] {
  const out = new Set<number>();
  const add = (s: string) => {
    for (const m of s.matchAll(/-?\d+(?:\.\d+)?/g)) out.add(Number(m[0]));
  };
  for (const row of rows) for (const v of Object.values(row)) if (v !== null && v !== undefined) add(String(v));
  return [...out];
}

/**
 * Grounding check for model-written text: every number it mentions must appear in the data (allowing for rounding),
 * be the row count, or be a small ordinal no larger than the row count. Anything else is treated as invented.
 */
export function isGrounded(text: string, rows: Record<string, unknown>[], totalRows: number): boolean {
  const data = numbersInData(rows);
  const cleaned = text.replace(/(\d),(?=\d{3}\b)/g, "$1");
  for (const m of cleaned.matchAll(/-?\d+(?:\.\d+)?/g)) {
    const v = Number(m[0]);
    if (Number.isNaN(v)) continue;
    if (Number.isInteger(v) && v >= 0 && v <= Math.max(totalRows, rows.length)) continue; // counts / ordinals
    const decimals = (m[0].split(".")[1] ?? "").length;
    const tol = 0.5 * Math.pow(10, -decimals) + 1e-9;
    if (data.some((d) => Math.abs(d - v) <= tol)) continue;
    // "1.2 million" style is not supported → treated as ungrounded
    return false;
  }
  return true;
}

export interface FormatResultOutput {
  formatted: FormattedResult;
  llmCall?: LlmCallRecord;
  /** Set only when the summary fell back to deterministic because the AI call itself failed (not merely "no rows" / deterministic mode). */
  notice?: { message: string } & Partial<RateLimitInfo>;
}

export async function formatResult(input: {
  question: string;
  explanation: string;
  columns: string[];
  rows: Record<string, unknown>[];
  truncated: boolean;
  provider?: AIProvider;
  mode: "llm" | "deterministic";
}): Promise<FormatResultOutput> {
  const base = deterministicSummary(input.columns, input.rows, input.truncated);
  const fallback: FormattedResult = { ...base, columns: input.columns, rows: input.rows, summarySource: "deterministic" };
  if (input.rows.length === 0 || input.mode === "deterministic" || !input.provider) return { formatted: fallback };

  const started = Date.now();
  try {
    const { system, user } = buildResultInterpretationPrompt({
      question: input.question,
      explanation: input.explanation,
      columns: input.columns,
      rows: input.rows,
      totalRows: input.rows.length,
      truncated: input.truncated,
    });
    const res = await input.provider.generateStructured({ system, prompt: user, schema: SummarySchema, schemaName: "result summary", maxTokens: 600 });
    const llmCall: LlmCallRecord = { purpose: "result_formatting", model: input.provider.model, latencyMs: Date.now() - started, ok: true };
    const text = [res.data.summary, ...res.data.key_points].join(" ");
    if (!isGrounded(text, input.rows, input.rows.length)) {
      return { formatted: fallback, llmCall: { ...llmCall, ok: false, error: "summary rejected by grounding check (numbers not present in data)" } };
    }
    return {
      formatted: { summary: res.data.summary, keyPoints: res.data.key_points.slice(0, 4), columns: input.columns, rows: input.rows, summarySource: "llm" },
      llmCall,
    };
  } catch (err) {
    // The data is already correct; a failed summary must not fail the request.
    const llmCall: LlmCallRecord = { purpose: "result_formatting", model: input.provider.model, latencyMs: Date.now() - started, ok: false, error: (err as Error).message.slice(0, 200) };
    const notice =
      err instanceof ProviderError && err.code === "PROVIDER_RATE_LIMIT"
        ? { message: "AI explanation temporarily unavailable — the results below are still accurate.", ...err.rateLimit }
        : undefined;
    return { formatted: fallback, llmCall, notice };
  }
}
