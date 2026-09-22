import { z } from "zod";
import type { AIProvider } from "@/lib/ai/provider";
import { buildDatasetDescriptionPrompt } from "@/lib/ai/prompts/dataset-description";
import type { IntrospectedSchema } from "./introspect";
import type { LlmDescriptions } from "./metadata-builder";

const Schema = z.object({
  tables: z
    .array(z.object({ name: z.string(), description: z.string().optional().default(""), columns: z.array(z.object({ name: z.string(), description: z.string().optional().default("") })).optional().default([]) }))
    .default([]),
});

const clean = (s: string) => s.replace(/\s+/g, " ").trim().slice(0, 240);

/**
 * Optional LLM pass that writes descriptions for tables/columns. The result is FILTERED against the real structure:
 * unknown table or column names are dropped, so the model can never add structure — it can only annotate what exists.
 * Sends names/types/keys only (no data).
 */
export async function describeSchemaWithLlm(provider: AIProvider, datasetName: string, schema: IntrospectedSchema): Promise<LlmDescriptions> {
  const input = {
    datasetName,
    tables: schema.tables.map((t) => ({
      name: t.name,
      columns: t.columns.map((c) => {
        const fk = t.foreignKeys.find((f) => f.columns.includes(c.name));
        return { name: c.name, type: c.type, primaryKey: t.primaryKey.includes(c.name), references: fk ? `${fk.refTable}.${fk.refColumns[fk.columns.indexOf(c.name)] ?? fk.refColumns[0]}` : undefined };
      }),
    })),
  };
  const { system, user } = buildDatasetDescriptionPrompt(input);
  const res = await provider.generateStructured({ system, prompt: user, schema: Schema, schemaName: "dataset descriptions", maxTokens: 3000 });

  const known = new Map(schema.tables.map((t) => [t.name, new Set(t.columns.map((c) => c.name))]));
  const out: LlmDescriptions = { tables: {}, columns: {} };
  for (const t of res.data.tables) {
    const cols = known.get(t.name);
    if (!cols) continue; // hallucinated table → ignored
    if (t.description.trim()) out.tables[t.name] = clean(t.description);
    for (const c of t.columns) {
      if (!cols.has(c.name) || !c.description.trim()) continue; // hallucinated column → ignored
      (out.columns[t.name] ??= {})[c.name] = clean(c.description);
    }
  }
  return out;
}
