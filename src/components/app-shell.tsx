"use client";

import { Database, MessageSquare, Sparkles } from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";

/**
 * Slim, persistent top-level navigation: the two conceptual destinations that exist outside any one dataset (the
 * main "Ask Data" workspace, and the dataset list). A dataset's own Dashboard/Ask/Data tabs live one level down,
 * in the dataset workspace layout (see src/app/datasets/[id]/layout.tsx) — this bar never grows to hold those too.
 */
export function AppShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const onDatasets = pathname?.startsWith("/datasets");

  const linkClass = (active: boolean) => `flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-sm font-medium transition-colors ${active ? "bg-accent text-primary" : "text-muted-foreground hover:text-foreground"}`;

  return (
    <div className="flex min-h-full flex-1 flex-col">
      <header className="sticky top-0 z-20 border-b border-border bg-card/95 backdrop-blur supports-[backdrop-filter]:bg-card/80">
        <div className="mx-auto flex h-12 max-w-6xl items-center justify-between px-4 sm:px-6">
          <Link href="/" className="flex items-center gap-1.5 text-primary">
            <Sparkles className="h-4 w-4" aria-hidden />
            <span className="text-sm font-semibold tracking-tight">Agentic NL2SQL</span>
          </Link>
          <nav aria-label="Main" className="flex items-center gap-1">
            <Link href="/" className={linkClass(!onDatasets)} aria-current={!onDatasets ? "page" : undefined}>
              <MessageSquare className="h-3.5 w-3.5" aria-hidden /> Ask Data
            </Link>
            <Link href="/datasets" className={linkClass(Boolean(onDatasets))} aria-current={onDatasets ? "page" : undefined}>
              <Database className="h-3.5 w-3.5" aria-hidden /> Datasets
            </Link>
          </nav>
        </div>
      </header>
      <div className="flex flex-1 flex-col">{children}</div>
    </div>
  );
}
