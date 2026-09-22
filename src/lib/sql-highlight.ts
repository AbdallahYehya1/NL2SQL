/** Minimal, dependency-free SQL tokenizer for syntax highlighting (display only). */

export type SqlTokenKind = "kw" | "fn" | "str" | "num" | "com" | "text";
export interface SqlToken {
  text: string;
  kind: SqlTokenKind;
}

const KEYWORDS = new Set(
  (
    "select from where group by order having limit offset join inner left right full outer cross on using as and or not in is null like ilike between exists " +
    "case when then else end with recursive union all intersect except distinct asc desc nulls first last over partition filter interval true false " +
    "cast fetch next rows only within lateral any some"
  ).split(" "),
);

const TOKEN = /(--[^\n]*|\/\*[\s\S]*?\*\/)|('(?:[^']|'')*')|(\b\d+(?:\.\d+)?\b)|([A-Za-z_][A-Za-z0-9_]*)|(\s+|[\s\S])/g;

export function tokenizeSql(sql: string): SqlToken[] {
  const tokens: SqlToken[] = [];
  for (const m of sql.matchAll(TOKEN)) {
    const [text, comment, str, num, word] = m;
    if (comment) tokens.push({ text, kind: "com" });
    else if (str) tokens.push({ text, kind: "str" });
    else if (num) tokens.push({ text, kind: "num" });
    else if (word) {
      const after = sql.slice((m.index ?? 0) + text.length).match(/^\s*\(/);
      if (KEYWORDS.has(text.toLowerCase())) tokens.push({ text, kind: "kw" });
      else if (after) tokens.push({ text, kind: "fn" });
      else tokens.push({ text, kind: "text" });
    } else tokens.push({ text, kind: "text" });
  }
  return tokens;
}
