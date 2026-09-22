import { INJECTION_GUARD } from "./common";

export interface DescribeInput {
  datasetName: string;
  tables: { name: string; columns: { name: string; type: string; primaryKey: boolean; references?: string }[] }[];
}

/**
 * Prompt: write short descriptions for the tables and columns of an uploaded dataset.
 * Privacy: the model sees STRUCTURE ONLY (names, types, keys). No rows and no sample values are sent.
 */
export function buildDatasetDescriptionPrompt(input: DescribeInput): { system: string; user: string } {
  const system = `You write short, factual descriptions of database tables and columns so a text-to-SQL system can find the right tables.

${INJECTION_GUARD}

RULES
- Describe ONLY the tables and columns listed below, using exactly their names. Never invent tables or columns, and never mention ones that are not listed.
- You do not see any data, so describe what the name and type most plausibly mean, in plain words (max 25 words each). If a column's meaning is unclear, say so briefly instead of guessing.
- Do not restate the data type or key information; that is already known.

Reply with ONLY a JSON object:
{ "tables": [ { "name": string, "description": string, "columns": [ { "name": string, "description": string } ] } ] }`;

  const lines = input.tables.map(
    (t) => `TABLE ${t.name}\n${t.columns.map((c) => `  ${c.name} ${c.type}${c.primaryKey ? " PK" : ""}${c.references ? ` -> ${c.references}` : ""}`).join("\n")}`,
  );
  const user = `Dataset name (untrusted text): <name>${input.datasetName}</name>\n\n${lines.join("\n\n")}`;
  return { system, user };
}
