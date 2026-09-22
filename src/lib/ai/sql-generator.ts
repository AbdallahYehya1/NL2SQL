import { z } from "zod";
import type { AIProvider } from "./provider";
import { buildSqlGenerationPrompt } from "./prompts/sql-generation";
import type { GeneratedSql, LlmCallRecord, QuestionIntent, SubSchema } from "@/lib/types";

const GeneratedSqlSchema = z.object({
  sql: z.string().min(1, "sql must not be empty"),
  explanation: z.string().optional().default(""),
  tables_used: z.array(z.string()).optional().default([]),
  assumptions: z.array(z.string()).optional().default([]),
});

/** Models sometimes wrap SQL in markdown fences inside the JSON string. */
export function cleanSqlText(sql: string): string {
  return sql
    .replace(/^\s*```(?:sql)?\s*/i, "")
    .replace(/\s*```\s*$/, "")
    .trim();
}

export async function generateSql(
  provider: AIProvider,
  input: { question: string; intent?: QuestionIntent; subSchema: SubSchema; today: string },
): Promise<{ generated: GeneratedSql; llmCall: LlmCallRecord }> {
  const { system, user } = buildSqlGenerationPrompt(input);
  const started = Date.now();
  const res = await provider.generateStructured({ system, prompt: user, schema: GeneratedSqlSchema, schemaName: "SQL generation", maxTokens: 1500 });
  return {
    generated: {
      sql: cleanSqlText(res.data.sql),
      explanation: res.data.explanation,
      tablesUsed: res.data.tables_used,
      assumptions: res.data.assumptions,
    },
    llmCall: { purpose: "sql_generation", model: provider.model, latencyMs: Date.now() - started, ok: true },
  };
}
