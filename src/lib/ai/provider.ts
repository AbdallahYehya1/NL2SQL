import type { ZodType } from "zod";
import { getConfig, type AppConfig } from "@/lib/config";

/**
 * Provider abstraction. The pipeline only ever talks to `AIProvider`; the concrete implementation speaks the
 * OpenAI-compatible HTTP API, which covers OpenRouter (free models), Groq, Gemini, Ollama (local),
 * OpenAI and any other compatible endpoint — selected purely through environment variables.
 */

export type ProviderErrorCode =
  | "PROVIDER_NOT_CONFIGURED"
  | "PROVIDER_AUTH"
  | "PROVIDER_RATE_LIMIT"
  | "PROVIDER_UNAVAILABLE"
  | "PROVIDER_BAD_OUTPUT";

export class ProviderError extends Error {
  constructor(
    readonly code: ProviderErrorCode,
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = "ProviderError";
  }
}

export interface GenerateRequest {
  system?: string;
  prompt: string;
  temperature?: number;
  maxTokens?: number;
}

export interface GenerateResult {
  text: string;
  latencyMs: number;
}

export interface StructuredRequest<T> extends GenerateRequest {
  schema: ZodType<T>;
  /** Short name used in error messages / logs. */
  schemaName: string;
}

export interface StructuredResult<T> {
  data: T;
  raw: string;
  latencyMs: number;
  /** 1 = valid first time, 2 = needed one repair round-trip. */
  attempts: number;
}

export interface AIProvider {
  readonly name: string;
  readonly model: string;
  readonly embeddingModel?: string;
  generate(req: GenerateRequest): Promise<GenerateResult>;
  generateStructured<T>(req: StructuredRequest<T>): Promise<StructuredResult<T>>;
  embed(texts: string[]): Promise<number[][]>;
  canEmbed(): boolean;
}

// ───────────────────────── JSON extraction ─────────────────────────
/** Pull the first JSON object out of model text (handles ```json fences, prose around it, <think> blocks). */
export function extractJson(text: string): unknown {
  const cleaned = text.replace(/<think>[\s\S]*?<\/think>/gi, "").trim();
  const fence = cleaned.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidates = [fence?.[1], cleaned].filter((c): c is string => !!c);
  for (const c of candidates) {
    try {
      return JSON.parse(c);
    } catch {
      /* try balanced-brace extraction */
    }
    const start = c.indexOf("{");
    if (start === -1) continue;
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let i = start; i < c.length; i++) {
      const ch = c[i];
      if (inString) {
        if (escaped) escaped = false;
        else if (ch === "\\") escaped = true;
        else if (ch === '"') inString = false;
        continue;
      }
      if (ch === '"') inString = true;
      else if (ch === "{") depth++;
      else if (ch === "}" && --depth === 0) {
        try {
          return JSON.parse(c.slice(start, i + 1));
        } catch {
          break;
        }
      }
    }
  }
  throw new Error("No valid JSON object found in model output");
}

// ───────────────────────── OpenAI-compatible implementation ─────────────────────────
interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

/** The subset of the OpenAI-compatible response payloads we read. */
interface ApiPayload {
  choices?: { message?: { content?: unknown } }[];
  data?: { embedding: number[]; index?: number }[];
  error?: { message?: string; code?: number | string } | string;
  message?: string;
  raw?: string;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export class OpenAICompatibleProvider implements AIProvider {
  readonly name: string;
  readonly model: string;
  readonly embeddingModel?: string;
  private jsonModeSupported = true;

  constructor(
    private readonly cfg: AppConfig["ai"],
    private readonly embCfg: AppConfig["embedding"],
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly retryDelayMs = 900,
  ) {
    this.name = cfg.provider;
    this.model = cfg.model ?? "";
    this.embeddingModel = embCfg.model;
  }

  private assertConfigured() {
    if (!this.model) throw new ProviderError("PROVIDER_NOT_CONFIGURED", "AI_MODEL is not configured. Set AI_PROVIDER, AI_MODEL and AI_API_KEY (see .env.example).");
    if (!this.cfg.baseUrl) throw new ProviderError("PROVIDER_NOT_CONFIGURED", "AI_BASE_URL is required when AI_PROVIDER=custom.");
    if (!this.cfg.apiKey && this.cfg.provider !== "ollama" && this.cfg.provider !== "custom") {
      throw new ProviderError("PROVIDER_NOT_CONFIGURED", "AI_API_KEY is not configured (see .env.example).");
    }
  }

  private async post(baseUrl: string, apiKey: string | undefined, path: string, body: unknown, timeoutMs: number): Promise<{ json: ApiPayload; status: number }> {
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
    if (baseUrl.includes("openrouter.ai")) {
      headers["X-Title"] = "Agentic NL2SQL";
    }
    let lastErr: ProviderError | undefined;
    const maxRetries = this.cfg.maxRetries;
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const res = await this.fetchImpl(`${baseUrl}${path}`, { method: "POST", headers, body: JSON.stringify(body), signal: controller.signal });
        const text = await res.text();
        let json: ApiPayload;
        try {
          json = text ? JSON.parse(text) : {};
        } catch {
          json = { raw: text.slice(0, 300) };
        }
        if (res.ok) {
          // some gateways return HTTP 200 with an error payload
          if (json?.error && !json?.choices && !json?.data) {
            const errObj = typeof json.error === "object" ? json.error : undefined;
            const msg = String(errObj?.message ?? json.error);
            const code = Number(errObj?.code);
            throw this.httpError(Number.isFinite(code) ? code : 502, msg);
          }
          return { json, status: res.status };
        }
        const errObj = typeof json?.error === "object" ? json.error : undefined;
        throw this.httpError(res.status, String(errObj?.message ?? (typeof json?.error === "string" ? json.error : undefined) ?? json?.message ?? json?.raw ?? res.statusText));
      } catch (err) {
        if (err instanceof ProviderError) lastErr = err;
        else if ((err as Error).name === "AbortError") lastErr = new ProviderError("PROVIDER_UNAVAILABLE", `The AI provider did not respond within ${Math.round(timeoutMs / 1000)}s.`);
        else lastErr = new ProviderError("PROVIDER_UNAVAILABLE", `Could not reach the AI provider: ${(err as Error).message}`);
        const retryable = lastErr.code === "PROVIDER_RATE_LIMIT" || lastErr.code === "PROVIDER_UNAVAILABLE";
        if (attempt < maxRetries && retryable && lastErr.status !== 404) {
          await sleep(this.retryDelayMs * (attempt + 1));
          continue;
        }
        throw lastErr;
      } finally {
        clearTimeout(timer);
      }
    }
    throw lastErr ?? new ProviderError("PROVIDER_UNAVAILABLE", "AI provider request failed.");
  }

  private httpError(status: number, message: string): ProviderError {
    const short = message.slice(0, 240);
    if (status === 401 || status === 403) return new ProviderError("PROVIDER_AUTH", `The AI provider rejected the API key (${status}). Check AI_API_KEY.`, status);
    if (status === 429) return new ProviderError("PROVIDER_RATE_LIMIT", "The AI provider rate limit was reached. Wait a moment and try again.", status);
    if (status === 404 || /model.*(not found|unavailable|does not exist)|no endpoints/i.test(short)) {
      return new ProviderError("PROVIDER_UNAVAILABLE", `The configured model is not available from the provider (${short}). Check AI_MODEL.`, status);
    }
    if (status === 400) return new ProviderError("PROVIDER_BAD_OUTPUT", `The AI provider rejected the request: ${short}`, status);
    return new ProviderError("PROVIDER_UNAVAILABLE", `The AI provider is unavailable (${status}).`, status);
  }

  private async chat(messages: ChatMessage[], opts: { temperature?: number; maxTokens?: number; json?: boolean; emptyRetries?: number }): Promise<GenerateResult> {
    this.assertConfigured();
    const started = Date.now();
    const body: Record<string, unknown> = {
      model: this.model,
      messages,
      temperature: opts.temperature ?? 0,
      max_tokens: opts.maxTokens ?? 1500,
    };
    if (opts.json && this.jsonModeSupported) body.response_format = { type: "json_object" };
    let json: ApiPayload;
    try {
      ({ json } = await this.post(this.cfg.baseUrl, this.cfg.apiKey, "/chat/completions", body, this.cfg.timeoutMs));
    } catch (err) {
      // Some models/providers reject response_format: remember and retry without it.
      if (opts.json && this.jsonModeSupported && err instanceof ProviderError && err.status === 400 && /response_format|json/i.test(err.message)) {
        this.jsonModeSupported = false;
        return this.chat(messages, { ...opts, json: false });
      }
      throw err;
    }
    const content = json?.choices?.[0]?.message?.content;
    const text = typeof content === "string" ? content : Array.isArray(content) ? content.map((c: { text?: string }) => c.text ?? "").join("") : "";
    if (!text.trim()) {
      // Free/shared endpoints sometimes return an empty completion (and may cache it for identical prompts).
      // Retry with a slightly higher temperature, which both varies the output and busts such caches.
      const used = opts.emptyRetries ?? 0;
      if (used < this.cfg.maxRetries) {
        await sleep(this.retryDelayMs * (used + 1));
        return this.chat(messages, { ...opts, temperature: Math.min(1, (opts.temperature ?? 0) + 0.2), emptyRetries: used + 1 });
      }
      throw new ProviderError("PROVIDER_BAD_OUTPUT", "The AI provider returned an empty response.");
    }
    return { text, latencyMs: Date.now() - started };
  }

  async generate(req: GenerateRequest): Promise<GenerateResult> {
    const messages: ChatMessage[] = [];
    if (req.system) messages.push({ role: "system", content: req.system });
    messages.push({ role: "user", content: req.prompt });
    return this.chat(messages, { temperature: req.temperature, maxTokens: req.maxTokens });
  }

  async generateStructured<T>(req: StructuredRequest<T>): Promise<StructuredResult<T>> {
    const messages: ChatMessage[] = [];
    if (req.system) messages.push({ role: "system", content: req.system });
    messages.push({ role: "user", content: req.prompt });

    const first = await this.chat(messages, { temperature: req.temperature, maxTokens: req.maxTokens, json: true });
    let latency = first.latencyMs;
    const problem = tryParse(first.text, req.schema);
    if (problem.ok) return { data: problem.data, raw: first.text, latencyMs: latency, attempts: 1 };

    // One repair round-trip: show the model its own output and the validation errors.
    const repair = await this.chat(
      [
        ...messages,
        { role: "assistant", content: first.text.slice(0, 4000) },
        { role: "user", content: `Your previous reply was not valid for the required "${req.schemaName}" JSON format: ${problem.error}\nReply again with ONLY the corrected JSON object, no prose, no code fences.` },
      ],
      { temperature: 0, maxTokens: req.maxTokens, json: true },
    );
    latency += repair.latencyMs;
    const second = tryParse(repair.text, req.schema);
    if (second.ok) return { data: second.data, raw: repair.text, latencyMs: latency, attempts: 2 };
    throw new ProviderError("PROVIDER_BAD_OUTPUT", `The model did not return valid ${req.schemaName} output: ${second.error}`);
  }

  canEmbed(): boolean {
    return Boolean(this.embCfg.model && this.embCfg.baseUrl && (this.embCfg.apiKey || this.embCfg.provider === "ollama" || this.embCfg.provider === "custom"));
  }

  async embed(texts: string[]): Promise<number[][]> {
    if (!this.canEmbed()) throw new ProviderError("PROVIDER_NOT_CONFIGURED", "EMBEDDING_MODEL is not configured, so vector search is disabled.");
    const body: Record<string, unknown> = { model: this.embCfg.model, input: texts, dimensions: this.embCfg.dimensions };
    let json: ApiPayload;
    try {
      ({ json } = await this.post(this.embCfg.baseUrl, this.embCfg.apiKey, "/embeddings", body, this.cfg.timeoutMs));
    } catch (err) {
      if (err instanceof ProviderError && err.status === 400) {
        // the endpoint may not accept `dimensions`
        delete body.dimensions;
        ({ json } = await this.post(this.embCfg.baseUrl, this.embCfg.apiKey, "/embeddings", body, this.cfg.timeoutMs));
      } else throw err;
    }
    const data = json?.data ?? [];
    if (data.length !== texts.length) throw new ProviderError("PROVIDER_BAD_OUTPUT", "Embedding response size mismatch.");
    const vectors = [...data].sort((a, b) => (a.index ?? 0) - (b.index ?? 0)).map((d) => d.embedding);
    for (const v of vectors) {
      if (v.length !== this.embCfg.dimensions) {
        throw new ProviderError(
          "PROVIDER_BAD_OUTPUT",
          `Embedding model returned ${v.length} dimensions but the database column is vector(${this.embCfg.dimensions}). Choose a model that supports ${this.embCfg.dimensions} dimensions.`,
        );
      }
    }
    return vectors;
  }
}

function tryParse<T>(text: string, schema: ZodType<T>): { ok: true; data: T } | { ok: false; error: string } {
  let value: unknown;
  try {
    value = extractJson(text);
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
  const parsed = schema.safeParse(value);
  if (parsed.success) return { ok: true, data: parsed.data };
  return { ok: false, error: parsed.error.issues.slice(0, 5).map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; ") };
}

// ───────────────────────── factory ─────────────────────────
let cachedProvider: AIProvider | undefined;

export function createProvider(cfg: AppConfig = getConfig()): AIProvider {
  return new OpenAICompatibleProvider(cfg.ai, cfg.embedding);
}

export function getProvider(): AIProvider {
  return (cachedProvider ??= createProvider());
}
