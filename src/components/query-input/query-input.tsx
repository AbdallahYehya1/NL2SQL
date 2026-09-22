"use client";

import { Loader2, Send } from "lucide-react";
import { useId, type FormEvent } from "react";
import { Button } from "@/components/ui/button";

export const EXAMPLE_QUESTIONS = [
  "Top 5 products by revenue",
  "Monthly revenue for the last 6 months",
  "Customers with more than 3 orders",
  "Which categories have declining sales?",
  "Which products are low in stock?",
  "What percentage of orders were refunded?",
];

const MAX = 500;

export function QueryInput({ value, onChange, onSubmit, loading, examples = EXAMPLE_QUESTIONS, placeholder }: { value: string; onChange: (v: string) => void; onSubmit: (q: string) => void; loading: boolean; examples?: string[]; placeholder?: string }) {
  const id = useId();

  function handle(e: FormEvent) {
    e.preventDefault();
    if (!loading && value.trim()) onSubmit(value.trim());
  }

  return (
    <form onSubmit={handle} className="space-y-3">
      <label htmlFor={id} className="text-sm font-medium">
        Ask your database anything
      </label>
      <div className="rounded-xl border border-border bg-card p-2 shadow-sm focus-within:ring-2 focus-within:ring-ring">
        <textarea
          id={id}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) handle(e);
          }}
          rows={2}
          maxLength={MAX}
          placeholder={placeholder ?? "What were the top 5 product categories by revenue last month?"}
          className="w-full resize-none bg-transparent px-2 py-1.5 text-base outline-none placeholder:text-muted-foreground"
          aria-describedby={`${id}-hint`}
        />
        <div className="flex items-center justify-between gap-2 px-1 pt-1">
          <span id={`${id}-hint`} className="text-xs text-muted-foreground">
            {value.length}/{MAX} · Ctrl/⌘ + Enter to ask
          </span>
          <Button type="submit" disabled={loading || !value.trim()}>
            {loading ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : <Send className="h-4 w-4" aria-hidden />}
            {loading ? "Thinking…" : "Ask"}
          </Button>
        </div>
      </div>
      <div className="flex flex-wrap gap-2" role="group" aria-label="Example questions">
        {examples.map((q) => (
          <button
            key={q}
            type="button"
            disabled={loading}
            onClick={() => {
              onChange(q);
              onSubmit(q);
            }}
            className="rounded-full border border-border bg-card px-3 py-1 text-xs text-muted-foreground transition-colors hover:border-primary hover:text-foreground disabled:opacity-50"
          >
            {q}
          </button>
        ))}
      </div>
    </form>
  );
}
