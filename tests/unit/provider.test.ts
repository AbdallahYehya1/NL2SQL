import { describe, expect, it } from "vitest";
import { z } from "zod";
import { extractJson, OpenAICompatibleProvider, ProviderError } from "@/lib/ai/provider";
import { loadConfig } from "@/lib/config";

const cfgFor = (env: Record<string, string>) => loadConfig({ AI_PROVIDER: "openrouter", AI_MODEL: "test/model", AI_API_KEY: "k", ...env });

function providerWith(responses: (() => Response)[], env: Record<string, string> = {}) {
  const cfg = cfgFor(env);
  const calls: { url: string; body: { response_format?: unknown; model?: string; messages?: unknown; temperature?: number } }[] = [];
  let i = 0;
  const fetchImpl = (async (url: string, init: RequestInit) => {
    calls.push({ url: String(url), body: JSON.parse(String(init.body)) });
    const make = responses[Math.min(i++, responses.length - 1)];
    return make();
  }) as unknown as typeof fetch;
  return { provider: new OpenAICompatibleProvider(cfg.ai, cfg.embedding, fetchImpl, 1), calls };
}

const chat = (content: string) => () => new Response(JSON.stringify({ choices: [{ message: { content } }] }), { status: 200 });
const status = (code: number, message = "err") => () => new Response(JSON.stringify({ error: { message } }), { status: code });

describe("extractJson", () => {
  it("parses plain JSON, fenced JSON, prose-wrapped JSON and <think> blocks", () => {
    expect(extractJson('{"a":1}')).toEqual({ a: 1 });
    expect(extractJson('```json\n{"a":1}\n```')).toEqual({ a: 1 });
    expect(extractJson('Sure! Here it is: {"a":{"b":"}"}} hope that helps')).toEqual({ a: { b: "}" } });
    expect(extractJson('<think>{"x":0}</think>{"a":2}')).toEqual({ a: 2 });
  });
  it("throws when there is no JSON", () => {
    expect(() => extractJson("no json here")).toThrow();
  });
});

describe("config", () => {
  it("resolves provider presets and lets AI_BASE_URL override", () => {
    expect(cfgFor({}).ai.baseUrl).toBe("https://openrouter.ai/api/v1");
    expect(cfgFor({ AI_PROVIDER: "groq" }).ai.baseUrl).toBe("https://api.groq.com/openai/v1");
    expect(cfgFor({ AI_PROVIDER: "custom", AI_BASE_URL: "http://localhost:8000/v1/" }).ai.baseUrl).toBe("http://localhost:8000/v1");
  });
  it("treats empty strings as unset and applies defaults", () => {
    const c = loadConfig({ AI_MODEL: "", MAX_ROWS: "" });
    expect(c.ai.model).toBeUndefined();
    expect(c.limits.maxRows).toBe(200);
    expect(c.limits.maxSqlAttempts).toBe(3);
  });
  it("lets embeddings use a different provider/key", () => {
    const c = cfgFor({ EMBEDDING_PROVIDER: "gemini", EMBEDDING_API_KEY: "g", EMBEDDING_MODEL: "gemini-embedding-001" });
    expect(c.embedding.baseUrl).toContain("generativelanguage");
    expect(c.embedding.apiKey).toBe("g");
    expect(c.embedding.dimensions).toBe(768);
  });
});

describe("OpenAICompatibleProvider", () => {
  const Schema = z.object({ sql: z.string() });

  it("fails clearly when not configured", async () => {
    const cfg = loadConfig({ AI_PROVIDER: "openrouter" });
    const p = new OpenAICompatibleProvider(cfg.ai, cfg.embedding, (async () => new Response("{}")) as unknown as typeof fetch);
    await expect(p.generate({ prompt: "x" })).rejects.toMatchObject({ code: "PROVIDER_NOT_CONFIGURED" });
  });

  it("returns validated structured output and requests JSON mode", async () => {
    const { provider, calls } = providerWith([chat('{"sql":"SELECT 1"}')]);
    const res = await provider.generateStructured({ prompt: "p", system: "s", schema: Schema, schemaName: "test" });
    expect(res.data).toEqual({ sql: "SELECT 1" });
    expect(res.attempts).toBe(1);
    expect(calls[0].body.response_format).toEqual({ type: "json_object" });
    expect(calls[0].body.model).toBe("test/model");
    expect(calls[0].url).toBe("https://openrouter.ai/api/v1/chat/completions");
  });

  it("repairs invalid output with one follow-up call", async () => {
    const { provider, calls } = providerWith([chat('{"wrong":1}'), chat('{"sql":"SELECT 2"}')]);
    const res = await provider.generateStructured({ prompt: "p", schema: Schema, schemaName: "test" });
    expect(res.data.sql).toBe("SELECT 2");
    expect(res.attempts).toBe(2);
    expect(calls).toHaveLength(2);
    expect(JSON.stringify(calls[1].body.messages)).toContain("not valid");
  });

  it("throws PROVIDER_BAD_OUTPUT after the repair also fails", async () => {
    const { provider } = providerWith([chat("nonsense"), chat("still nonsense")]);
    await expect(provider.generateStructured({ prompt: "p", schema: Schema, schemaName: "test" })).rejects.toMatchObject({ code: "PROVIDER_BAD_OUTPUT" });
  });

  it("maps HTTP failures to typed errors", async () => {
    for (const [code, expected] of [[401, "PROVIDER_AUTH"], [403, "PROVIDER_AUTH"], [404, "PROVIDER_UNAVAILABLE"]] as const) {
      const { provider } = providerWith([status(code)]);
      await expect(provider.generate({ prompt: "p" })).rejects.toMatchObject({ code: expected });
    }
  });

  it("retries once on rate limit and then reports PROVIDER_RATE_LIMIT", async () => {
    const { provider, calls } = providerWith([status(429), status(429)]);
    await expect(provider.generate({ prompt: "p" })).rejects.toMatchObject({ code: "PROVIDER_RATE_LIMIT" });
    expect(calls).toHaveLength(2);
  });

  it("honours AI_MAX_RETRIES", async () => {
    const { provider, calls } = providerWith([status(502), status(502), status(502), chat("ok")], { AI_MAX_RETRIES: "3" });
    expect((await provider.generate({ prompt: "p" })).text).toBe("ok");
    expect(calls).toHaveLength(4);
    const none = providerWith([status(502), chat("ok")], { AI_MAX_RETRIES: "0" });
    await expect(none.provider.generate({ prompt: "p" })).rejects.toMatchObject({ code: "PROVIDER_UNAVAILABLE" });
    expect(none.calls).toHaveLength(1);
  });

  it("recovers when the retry succeeds", async () => {
    const { provider } = providerWith([status(503), chat("ok")]);
    expect((await provider.generate({ prompt: "p" })).text).toBe("ok");
  });

  it("falls back to no response_format when the provider rejects it", async () => {
    const { provider, calls } = providerWith([status(400, "response_format is not supported"), chat('{"sql":"SELECT 3"}')]);
    const res = await provider.generateStructured({ prompt: "p", schema: Schema, schemaName: "test" });
    expect(res.data.sql).toBe("SELECT 3");
    expect(calls[1].body.response_format).toBeUndefined();
  });

  it("treats a persistently empty completion as bad output", async () => {
    const { provider } = providerWith([chat("   ")]);
    await expect(provider.generate({ prompt: "p" })).rejects.toBeInstanceOf(ProviderError);
  });

  it("retries an empty completion with a higher temperature", async () => {
    const { provider, calls } = providerWith([chat(""), chat("recovered")]);
    expect((await provider.generate({ prompt: "p", temperature: 0 })).text).toBe("recovered");
    expect(calls).toHaveLength(2);
    expect(calls[0].body.temperature).toBe(0);
    expect(calls[1].body.temperature).toBeCloseTo(0.2);
  });

  it("validates embedding dimensions against the database column", async () => {
    const bad = () => new Response(JSON.stringify({ data: [{ embedding: [0.1, 0.2], index: 0 }] }), { status: 200 });
    const { provider } = providerWith([bad], { EMBEDDING_MODEL: "m" });
    await expect(provider.embed(["x"])).rejects.toMatchObject({ code: "PROVIDER_BAD_OUTPUT" });
  });

  it("reports embeddings as unavailable without EMBEDDING_MODEL", async () => {
    const { provider } = providerWith([chat("x")]);
    expect(provider.canEmbed()).toBe(false);
    await expect(provider.embed(["x"])).rejects.toMatchObject({ code: "PROVIDER_NOT_CONFIGURED" });
  });
});
