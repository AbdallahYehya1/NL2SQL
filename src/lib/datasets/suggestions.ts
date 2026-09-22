import type { MetadataRegistry, TableMeta } from "@/lib/types";

/** Deterministic example questions generated from the registry structure (no LLM, no data). */
const words = (n: string) => n.replace(/_+/g, " ").trim();
const singular = (w: string) => (w.endsWith("ies") ? `${w.slice(0, -3)}y` : w.endsWith("ss") || w.endsWith("us") ? w : w.endsWith("s") ? w.slice(0, -1) : w);
const isNumeric = (t: string) => /^(smallint|integer|bigint|numeric|real|double)/.test(t);
const isDate = (t: string) => /^(date|timestamp)/.test(t);
const isNameLike = (n: string) => /(^|_)(name|title|label)$/.test(n) || n === "name";
const measure = (t: TableMeta) => t.columns.find((c) => isNumeric(c.type) && !c.primaryKey && !c.references && !/(^|_)id$/.test(c.name));
const label = (t: TableMeta) => t.columns.find((c) => isNameLike(c.name));

export function suggestQuestions(registry: MetadataRegistry, max = 5): string[] {
  const out: string[] = [];
  const add = (q: string) => {
    if (out.length < max && !out.includes(q)) out.push(q);
  };

  // measure per group across a real relationship: "average salary for each department"
  for (const r of registry.relationships) {
    const from = registry.tables.find((t) => t.name === r.fromTable);
    const to = registry.tables.find((t) => t.name === r.toTable);
    if (!from || !to || !label(to)) continue;
    const m = measure(from);
    if (m) add(`What is the average ${words(m.name)} for each ${singular(words(to.name))}?`);
  }
  for (const t of registry.tables) {
    const m = measure(t);
    if (m && label(t)) add(`What are the top 5 ${words(t.name)} by ${words(m.name)}?`);
    const d = t.columns.find((c) => isDate(c.type));
    if (d) add(`How many ${words(t.name)} per month, based on ${words(d.name)}?`);
  }
  for (const t of registry.tables) add(`How many ${words(t.name)} are there?`);
  return out;
}
