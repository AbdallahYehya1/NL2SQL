import { z } from "zod";
import type { AIProvider } from "./provider";
import { cleanSqlText } from "./sql-generator";
import { buildSqlCorrectionPrompt } from "./prompts/sql-correction";
import type { CorrectionAttempt, GeneratedSql, LlmCallRecord, SubSchema } from "@/lib/types";

const CorrectionSchema = z.object({
  diagnosis: z.string().min(1, "diagnosis must not be empty"),
  sql: z.string().min(1, "sql must not be empty"),
  explanation: z.string().optional().default(""),
  tables_used: z.array(z.string()).optional().default([]),
  assumptions: z.array(z.string()).optional().default([]),
});

/**
 * Self-correction agent: given the failed SQL and the validator/database error, it must first diagnose the
 * cause and then return a repaired statement. The orchestrator re-validates and re-executes the result.
 */
export async function correctSql(
  provider: AIProvider,
  input: {
    question: string;
    failedSql: string;
    failureStage: "validation" | "execution";
    error: { code: string; message: string };
    previousAttempts: CorrectionAttempt[];
    subSchema: SubSchema;
    today: string;
  },
): Promise<{ diagnosis: string; generated: GeneratedSql; llmCall: LlmCallRecord }> {
  const { system, user } = buildSqlCorrectionPrompt(input);
  const started = Date.now();
  const res = await provider.generateStructured({ system, prompt: user, schema: CorrectionSchema, schemaName: "SQL correction", maxTokens: 1500 });
  return {
    diagnosis: res.data.diagnosis,
    generated: { sql: cleanSqlText(res.data.sql), explanation: res.data.explanation, tablesUsed: res.data.tables_used, assumptions: res.data.assumptions },
    llmCall: { purpose: "sql_correction", model: provider.model, latencyMs: Date.now() - started, ok: true },
  };
}
