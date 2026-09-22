import type { ZodType } from "zod";
import type { AIProvider, GenerateRequest, GenerateResult, StructuredRequest, StructuredResult } from "@/lib/ai/provider";

/**
 * Test double for the LLM. It returns pre-scripted JSON per pipeline stage (identified by schemaName) so the
 * orchestration, validation, execution and self-correction logic can be tested deterministically.
 * It exists only in tests — the application never uses mock AI responses.
 */
export type Script = Record<string, unknown[] | ((n: number) => unknown)>;

export class ScriptedProvider implements AIProvider {
  readonly name = "scripted";
  readonly model = "scripted-model";
  readonly embeddingModel = undefined;
  calls: { schemaName: string; prompt: string; system?: string }[] = [];
  private counters = new Map<string, number>();

  constructor(private readonly script: Script) {}

  callsFor(schemaName: string) {
    return this.calls.filter((c) => c.schemaName === schemaName);
  }

  async generate(req: GenerateRequest): Promise<GenerateResult> {
    void req;
    return { text: "", latencyMs: 0 };
  }

  async generateStructured<T>(req: StructuredRequest<T>): Promise<StructuredResult<T>> {
    this.calls.push({ schemaName: req.schemaName, prompt: req.prompt, system: req.system });
    const n = this.counters.get(req.schemaName) ?? 0;
    this.counters.set(req.schemaName, n + 1);
    const entry = this.script[req.schemaName];
    if (entry === undefined) throw new Error(`ScriptedProvider: no script for "${req.schemaName}"`);
    const value = typeof entry === "function" ? entry(n) : entry[Math.min(n, entry.length - 1)];
    if (value instanceof Error) throw value;
    const data = (req.schema as ZodType<T>).parse(value);
    return { data, raw: JSON.stringify(value), latencyMs: 1, attempts: 1 };
  }

  async embed(): Promise<number[][]> {
    throw new Error("not configured");
  }

  canEmbed() {
    return false;
  }
}

export const analysisOk = (over: Record<string, unknown> = {}) => ({
  in_scope: true,
  scope_reason: "",
  needs_clarification: false,
  clarification_question: null,
  clarification_options: [],
  query_type: "ranking",
  concepts: [],
  search_terms: [],
  time_range: null,
  assumptions: [],
  ...over,
});

export const sqlAnswer = (sql: string, over: Record<string, unknown> = {}) => ({
  sql,
  explanation: "test query",
  tables_used: [],
  assumptions: [],
  ...over,
});
