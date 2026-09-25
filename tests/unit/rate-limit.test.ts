import { describe, expect, it } from "vitest";
import { parseRateLimitDuration, parseRateLimitHeaders, ProviderError } from "@/lib/ai/provider";
import { loadConfig } from "@/lib/config";
import { OpenAICompatibleProvider } from "@/lib/ai/provider";

const cfgFor = (env: Record<string, string> = {}) => loadConfig({ AI_PROVIDER: "groq", AI_MODEL: "openai/gpt-oss-120b", AI_API_KEY: "k", ...env });

describe("parseRateLimitDuration — Groq's compound duration strings", () => {
  it("parses minutes+seconds", () => expect(parseRateLimitDuration("38m52.8s")).toBeCloseTo(2332.8));
  it("parses milliseconds", () => expect(parseRateLimitDuration("577ms")).toBeCloseTo(0.577));
  it("parses plain seconds", () => expect(parseRateLimitDuration("12s")).toBe(12));
  it("parses hours", () => expect(parseRateLimitDuration("2h")).toBe(7200));
  it("returns undefined for unparseable input, never a guessed number", () => expect(parseRateLimitDuration("")).toBeUndefined());
});

describe("parseRateLimitHeaders — real provider headers only, never a fabricated value", () => {
  const now = Date.parse("2026-09-23T12:00:00.000Z");

  it("classifies a per-minute REQUEST limit from remaining-requests=0 and a short reset", () => {
    const h = new Headers({ "x-ratelimit-remaining-requests": "0", "x-ratelimit-reset-requests": "38m52.8s", "x-ratelimit-remaining-tokens": "4000", "x-ratelimit-reset-tokens": "2s" });
    const info = parseRateLimitHeaders(h, now);
    expect(info.limitType).toBe("REQUESTS_PER_MINUTE");
    expect(info.retryAfterSeconds).toBeCloseTo(2332.8);
    expect(info.resetAt).toBe(new Date(now + 2332.8 * 1000).toISOString());
  });

  it("classifies a per-day TOKEN limit when the reset is many hours out", () => {
    const h = new Headers({ "x-ratelimit-remaining-tokens": "0", "x-ratelimit-reset-tokens": "14h32m", "x-ratelimit-remaining-requests": "10", "x-ratelimit-reset-requests": "5s" });
    const info = parseRateLimitHeaders(h, now);
    expect(info.limitType).toBe("TOKENS_PER_DAY");
    expect(info.retryAfterSeconds).toBeCloseTo(14 * 3600 + 32 * 60);
  });

  it("prefers the standard Retry-After header (seconds) when present", () => {
    const h = new Headers({ "retry-after": "18", "x-ratelimit-remaining-requests": "0", "x-ratelimit-reset-requests": "999s" });
    const info = parseRateLimitHeaders(h, now);
    expect(info.retryAfterSeconds).toBe(18);
  });

  it("falls back to UNKNOWN with no countdown when nothing informative is present", () => {
    const info = parseRateLimitHeaders(new Headers(), now);
    expect(info.limitType).toBe("UNKNOWN");
    expect(info.retryAfterSeconds).toBeUndefined();
    expect(info.resetAt).toBeUndefined();
  });
});

describe("OpenAICompatibleProvider — 429 carries structured rate-limit info end to end", () => {
  it("attaches real header values to the thrown ProviderError", async () => {
    const cfg = cfgFor();
    const fetchImpl = (async () =>
      new Response(JSON.stringify({ error: { message: "rate limited" } }), {
        status: 429,
        headers: { "retry-after": "18", "x-ratelimit-remaining-requests": "0", "x-ratelimit-reset-requests": "18s", "x-ratelimit-remaining-tokens": "5000", "x-ratelimit-reset-tokens": "1s" },
      })) as unknown as typeof fetch;
    const provider = new OpenAICompatibleProvider(cfg.ai, cfg.embedding, fetchImpl, 1);
    await expect(provider.generate({ prompt: "p" })).rejects.toSatisfy((err: unknown) => {
      expect(err).toBeInstanceOf(ProviderError);
      const pe = err as ProviderError;
      expect(pe.code).toBe("PROVIDER_RATE_LIMIT");
      expect(pe.rateLimit?.limitType).toBe("REQUESTS_PER_MINUTE");
      expect(pe.rateLimit?.retryAfterSeconds).toBe(18);
      expect(pe.rateLimit?.resetAt).toBeDefined();
      return true;
    });
  });

  it("never hardcodes a number when the 429 has no rate-limit headers at all", async () => {
    const cfg = cfgFor();
    const fetchImpl = (async () => new Response(JSON.stringify({ error: { message: "rate limited" } }), { status: 429 })) as unknown as typeof fetch;
    const provider = new OpenAICompatibleProvider(cfg.ai, cfg.embedding, fetchImpl, 1);
    await expect(provider.generate({ prompt: "p" })).rejects.toSatisfy((err: unknown) => {
      const pe = err as ProviderError;
      expect(pe.rateLimit?.limitType).toBe("UNKNOWN");
      expect(pe.rateLimit?.retryAfterSeconds).toBeUndefined();
      return true;
    });
  });
});
