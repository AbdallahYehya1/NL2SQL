import { z } from "zod";

/**
 * Central, validated configuration. Everything comes from environment variables (see .env.example).
 * Server-side only: never import this from a client component.
 */

export const AI_PROVIDER_PRESETS = {
  openrouter: "https://openrouter.ai/api/v1",
  openai: "https://api.openai.com/v1",
  groq: "https://api.groq.com/openai/v1",
  gemini: "https://generativelanguage.googleapis.com/v1beta/openai",
  ollama: "http://localhost:11434/v1",
  custom: "",
} as const;

export type AIProviderName = keyof typeof AI_PROVIDER_PRESETS;

const emptyToUndefined = (v: unknown) => (typeof v === "string" && v.trim() === "" ? undefined : v);
const optionalString = z.preprocess(emptyToUndefined, z.string().optional());
const intWithDefault = (def: number, min = 1, max = 1_000_000) =>
  z.preprocess(emptyToUndefined, z.coerce.number().int().min(min).max(max).default(def));

const envSchema = z.object({
  DATABASE_URL: optionalString,
  READONLY_DATABASE_URL: optionalString,
  DATABASE_SSL: z.preprocess(emptyToUndefined, z.enum(["auto", "true", "false"]).default("auto")),
  DB_EXECUTION_ROLE: z.preprocess(emptyToUndefined, z.string().regex(/^[a-z_][a-z0-9_]*$/).default("nl2sql_readonly")),

  AI_PROVIDER: z.preprocess(emptyToUndefined, z.enum(["openrouter", "openai", "groq", "gemini", "ollama", "custom"]).default("openrouter")),
  AI_BASE_URL: optionalString,
  AI_API_KEY: optionalString,
  AI_MODEL: optionalString,
  AI_TIMEOUT_MS: intWithDefault(45_000, 1000, 300_000),
  AI_MAX_RETRIES: intWithDefault(1, 0, 5),

  EMBEDDING_PROVIDER: z.preprocess(emptyToUndefined, z.enum(["openrouter", "openai", "groq", "gemini", "ollama", "custom"]).optional()),
  EMBEDDING_BASE_URL: optionalString,
  EMBEDDING_API_KEY: optionalString,
  EMBEDDING_MODEL: optionalString,

  ANALYSIS_MODE: z.preprocess(emptyToUndefined, z.enum(["llm", "rules"]).default("llm")),
  SUMMARY_MODE: z.preprocess(emptyToUndefined, z.enum(["llm", "deterministic"]).default("llm")),
  MAX_ROWS: intWithDefault(200, 1, 5000),
  QUERY_TIMEOUT_MS: intWithDefault(8000, 500, 60_000),
  MAX_SQL_ATTEMPTS: intWithDefault(3, 1, 5),
  MAX_QUESTION_LENGTH: intWithDefault(500, 20, 2000),
  RATE_LIMIT_PER_MINUTE: intWithDefault(12, 1, 1000),
  RATE_LIMIT_SALT: optionalString,
});

export type AppConfig = ReturnType<typeof loadConfig>;

export const EMBEDDING_DIMENSIONS = 768;

export function loadConfig(env: Record<string, string | undefined> = process.env) {
  const e = envSchema.parse(env);
  const embeddingProvider = e.EMBEDDING_PROVIDER ?? e.AI_PROVIDER;
  return {
    databaseUrl: e.DATABASE_URL,
    readonlyDatabaseUrl: e.READONLY_DATABASE_URL,
    databaseSsl: e.DATABASE_SSL,
    executionRole: e.DB_EXECUTION_ROLE,
    ai: {
      provider: e.AI_PROVIDER as AIProviderName,
      baseUrl: (e.AI_BASE_URL ?? AI_PROVIDER_PRESETS[e.AI_PROVIDER]).replace(/\/+$/, ""),
      apiKey: e.AI_API_KEY,
      model: e.AI_MODEL,
      timeoutMs: e.AI_TIMEOUT_MS,
      maxRetries: e.AI_MAX_RETRIES,
    },
    embedding: {
      provider: embeddingProvider as AIProviderName,
      baseUrl: (e.EMBEDDING_BASE_URL ?? (e.EMBEDDING_PROVIDER ? AI_PROVIDER_PRESETS[e.EMBEDDING_PROVIDER] : undefined) ?? (e.AI_BASE_URL ?? AI_PROVIDER_PRESETS[e.AI_PROVIDER])).replace(/\/+$/, ""),
      apiKey: e.EMBEDDING_API_KEY ?? e.AI_API_KEY,
      model: e.EMBEDDING_MODEL,
      dimensions: EMBEDDING_DIMENSIONS,
    },
    analysisMode: e.ANALYSIS_MODE,
    summaryMode: e.SUMMARY_MODE,
    limits: {
      maxRows: e.MAX_ROWS,
      queryTimeoutMs: e.QUERY_TIMEOUT_MS,
      maxSqlAttempts: e.MAX_SQL_ATTEMPTS,
      maxQuestionLength: e.MAX_QUESTION_LENGTH,
      rateLimitPerMinute: e.RATE_LIMIT_PER_MINUTE,
    },
    rateLimitSalt: e.RATE_LIMIT_SALT ?? "nl2sql-demo-salt",
  };
}

let cached: AppConfig | undefined;
/** Lazily loaded singleton so importing this module never throws at build time. */
export function getConfig(): AppConfig {
  return (cached ??= loadConfig());
}

/** Test helper: forget the cached configuration so changed environment variables are re-read. */
export function resetConfigCache(): void {
  cached = undefined;
}
