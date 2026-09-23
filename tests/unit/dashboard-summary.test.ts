import { describe, expect, it } from "vitest";
import { buildSummary } from "@/lib/dashboard/summary-engine";
import { ProviderError } from "@/lib/ai/provider";
import { ScriptedProvider } from "../helpers/scripted-provider";
import type { InsightFact } from "@/lib/dashboard/types";

const facts: InsightFact[] = [
  { id: "1", type: "PEAK", metric: "Orders", value: 28, period: "July", sourceTables: ["orders"], sourceColumns: ["order_date"], confidence: "HIGH", statement: "July recorded the highest orders, at 28.", priority: 90 },
  { id: "2", type: "TREND", metric: "Orders", value: 28, previousValue: 20, changePercent: 18, period: "Jan–Jun", sourceTables: ["orders"], sourceColumns: ["order_date"], confidence: "HIGH", statement: "Orders increased from Jan through Jun, by about 18%.", priority: 85 },
];

describe("dashboard summary — facts first, AI only rephrases", () => {
  it("uses the deterministic statements directly when mode is deterministic", async () => {
    const { summary } = await buildSummary(facts, undefined, "deterministic");
    expect(summary.source).toBe("deterministic");
    expect(summary.sentences).toEqual(facts.slice(0, 3).map((f) => f.statement));
  });

  it("uses the AI rewrite when it is grounded in the given facts", async () => {
    const provider = new ScriptedProvider({ "dashboard summary": [{ sentences: ["July was the busiest month, with 28 orders — up about 18% since January."] }] });
    const { summary } = await buildSummary(facts, provider, "llm");
    expect(summary.source).toBe("llm");
    expect(summary.sentences[0]).toContain("28");
  });

  it("falls back to deterministic statements when the AI invents a number not in the facts", async () => {
    const provider = new ScriptedProvider({ "dashboard summary": [{ sentences: ["Orders grew because of a new marketing campaign that reached 500,000 people."] }] });
    const { summary } = await buildSummary(facts, provider, "llm");
    expect(summary.source).toBe("deterministic");
  });

  it("falls back gracefully (with a notice) when the AI call is rate-limited", async () => {
    const rateLimit = { limitType: "REQUESTS_PER_MINUTE" as const, retryAfterSeconds: 12, resetAt: "2026-09-23T12:00:12.000Z" };
    const provider = new ScriptedProvider({ "dashboard summary": [new ProviderError("PROVIDER_RATE_LIMIT", "rate limited", 429, rateLimit)] });
    const { summary, notice } = await buildSummary(facts, provider, "llm");
    expect(summary.source).toBe("deterministic");
    expect(summary.sentences.length).toBeGreaterThan(0); // never blank
    expect(notice?.retryAfterSeconds).toBe(12);
  });

  it("has a safe placeholder (never blank) when there are no facts at all", async () => {
    const { summary } = await buildSummary([], undefined, "deterministic");
    expect(summary.sentences.length).toBeGreaterThan(0);
  });
});
