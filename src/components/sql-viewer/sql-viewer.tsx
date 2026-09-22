"use client";

import { Check, Copy } from "lucide-react";
import { useMemo, useState } from "react";
import { format } from "sql-formatter";
import { tokenizeSql } from "@/lib/sql-highlight";
import { Button } from "@/components/ui/button";

function prettify(sql: string): string {
  try {
    return format(sql, { language: "postgresql", keywordCase: "upper", tabWidth: 2 });
  } catch {
    return sql;
  }
}

export function SqlViewer({ sql, label = "Generated SQL" }: { sql: string; label?: string }) {
  const [copied, setCopied] = useState(false);
  const pretty = useMemo(() => prettify(sql), [sql]);
  const tokens = useMemo(() => tokenizeSql(pretty), [pretty]);

  async function copy() {
    try {
      await navigator.clipboard.writeText(pretty);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard unavailable */
    }
  }

  return (
    <figure className="overflow-hidden rounded-lg border border-border bg-code-bg">
      <figcaption className="flex items-center justify-between border-b border-white/10 px-3 py-1.5 text-xs text-slate-400">
        <span>{label}</span>
        <Button variant="ghost" size="sm" onClick={copy} aria-label="Copy SQL to clipboard" className="h-7 text-slate-300 hover:bg-white/10">
          {copied ? <Check className="h-3.5 w-3.5" aria-hidden /> : <Copy className="h-3.5 w-3.5" aria-hidden />}
          {copied ? "Copied" : "Copy"}
        </Button>
      </figcaption>
      <pre className="overflow-x-auto p-3 font-mono text-[13px] leading-relaxed text-code-fg" tabIndex={0}>
        <code>
          {tokens.map((t, i) => (t.kind === "text" ? t.text : <span key={i} className={`sql-${t.kind}`}>{t.text}</span>))}
        </code>
      </pre>
    </figure>
  );
}
