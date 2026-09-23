"use client";

import { ChevronDown, Code2, GitBranch } from "lucide-react";
import { ExecutionTrace } from "@/components/execution-trace/execution-trace";
import { SqlViewer } from "@/components/sql-viewer/sql-viewer";
import { Badge } from "@/components/ui/badge";
import type { QueryResponse } from "@/lib/types";

export type DetailsTab = "sql" | "trace";

/**
 * SQL and the agent trace remain fully available for technical users, but de-emphasized: collapsed by default,
 * visually quieter than the AI Insight / Visualization above it (rule: the answer must be understandable without
 * opening this).
 */
export function AdvancedDetails({
  result,
  open,
  onToggle,
  tab,
  onTabChange,
}: {
  result: QueryResponse;
  open: boolean;
  onToggle: () => void;
  tab: DetailsTab;
  onTabChange: (t: DetailsTab) => void;
}) {
  return (
    <div className="border-t border-border pt-3">
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={open}
        className="flex w-full items-center justify-between text-left text-xs font-medium text-muted-foreground hover:text-foreground"
      >
        <span className="flex items-center gap-3">
          Advanced details
          <span className="hidden sm:inline">
            <Badge>{result.trace.subSchema?.tables.length ?? result.tablesUsed.length} tables selected</Badge>
          </span>
          <span className="hidden sm:inline">
            <Badge>{result.trace.routing?.method === "hybrid" ? "hybrid retrieval" : "lexical retrieval"}</Badge>
          </span>
        </span>
        <ChevronDown className={`h-4 w-4 transition-transform duration-200 ${open ? "rotate-180" : ""}`} aria-hidden />
      </button>

      {open && (
        <div className="mt-3 animate-result-in space-y-3">
          <div role="tablist" aria-label="Details" className="flex gap-1 border-b border-border">
            <TabButton active={tab === "sql"} onClick={() => onTabChange("sql")} icon={<Code2 className="h-3.5 w-3.5" aria-hidden />}>
              SQL
            </TabButton>
            <TabButton active={tab === "trace"} onClick={() => onTabChange("trace")} icon={<GitBranch className="h-3.5 w-3.5" aria-hidden />}>
              Agent trace
            </TabButton>
          </div>
          {tab === "sql" && result.sql && (
            <div className="space-y-2">
              <SqlViewer sql={result.sql} />
              {result.explanation && <p className="text-sm text-muted-foreground">{result.explanation}</p>}
              {result.columnsUsed.length > 0 && (
                <p className="flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
                  Columns used:{" "}
                  {result.columnsUsed.map((c) => (
                    <Badge key={c} className="font-mono">
                      {c}
                    </Badge>
                  ))}
                </p>
              )}
            </div>
          )}
          {tab === "trace" && <ExecutionTrace result={result} />}
        </div>
      )}
    </div>
  );
}

function TabButton({ active, onClick, icon, children }: { active: boolean; onClick: () => void; icon: React.ReactNode; children: React.ReactNode }) {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={active}
      onClick={onClick}
      className={`-mb-px flex items-center gap-1.5 border-b-2 px-3 py-2 text-sm transition-colors ${active ? "border-primary font-medium text-foreground" : "border-transparent text-muted-foreground hover:text-foreground"}`}
    >
      {icon}
      {children}
    </button>
  );
}
