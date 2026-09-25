import { z } from "zod";
import type { AIProvider } from "@/lib/ai/provider";
import { ProviderError } from "@/lib/ai/provider";
import { isGrounded } from "@/lib/ai/result-formatter";
import type { RateLimitInfo } from "@/lib/types";
import type { DashboardSummary, InsightFact } from "./types";

/**
 * "What stands out" — reuses the exact same facts-first pattern as the query-result summary (result-formatter.ts):
 * the AI may only rephrase InsightFact.statement sentences (already deterministic, already safe to show on their
 * own) into smoother prose; it never receives raw data or an open brief to invent from, and its output is grounding-
 * checked against the facts' own numbers before being trusted (isGrounded, reused from result-formatter.ts). Any
 * failure — including a rate limit — falls back to the deterministic statements, which are always shown regardless.
 */

const SummarySchema = z.object({ sentences: z.array(z.string().min(1)).min(1).max(4) });

function deterministicSentences(facts: InsightFact[]): string[] {
  if (facts.length === 0) return ["Nothing stood out yet — ask a question below to start exploring this dataset."];
  return facts.slice(0, 3).map((f) => f.statement);
}

export interface SummaryNotice {
  message: string;
}

export async function buildSummary(facts: InsightFact[], provider: AIProvider | undefined, mode: "llm" | "deterministic"): Promise<{ summary: DashboardSummary; notice?: (SummaryNotice & Partial<RateLimitInfo>) | undefined }> {
  const fallback = deterministicSentences(facts);
  if (facts.length === 0 || mode === "deterministic" || !provider) {
    return { summary: { sentences: fallback, source: "deterministic" } };
  }

  try {
    const factLines = facts
      .slice(0, 5)
      .map((f) => `- ${f.statement}`)
      .join("\n");
    const system =
      'You turn a short list of ALREADY-VERIFIED data facts into 2-4 short, natural, human-sounding sentences for a dashboard\'s "What stands out" section. Rules: use ONLY the facts given, never invent a number, date, percentage, category, or causal explanation that is not already stated; never write "As an AI" or "Based on the data, it can be observed that"; lead with the single most important finding; write plain prose, no bullet points, no headers.';
    const user = `Facts:\n${factLines}\n\nWrite 2-4 short sentences using only these facts.`;
    const res = await provider.generateStructured({ system, prompt: user, schema: SummarySchema, schemaName: "dashboard summary", maxTokens: 300 });
    const text = res.data.sentences.join(" ");
    const factRows = facts.map((f) => ({ value: f.value, previousValue: f.previousValue, changePercent: f.changePercent }));
    if (!isGrounded(text, factRows, facts.length)) {
      return { summary: { sentences: fallback, source: "deterministic" } };
    }
    return { summary: { sentences: res.data.sentences, source: "llm" } };
  } catch (err) {
    const notice: (SummaryNotice & Partial<RateLimitInfo>) | undefined =
      err instanceof ProviderError && err.code === "PROVIDER_RATE_LIMIT" ? { message: "AI summary temporarily unavailable — the facts below are still accurate.", ...err.rateLimit } : undefined;
    return { summary: { sentences: fallback, source: "deterministic" }, notice };
  }
}
