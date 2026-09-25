"use client";

import { useEffect, useState } from "react";
import { Skeleton } from "@/components/ui/skeleton";
import { AskThisData } from "./ask-this-data";

/**
 * The dataset workspace's own "Ask this data" destination — a real, separately-navigable route (see
 * src/app/datasets/[id]/layout.tsx) so leaving it and coming back is ordinary browser history, not custom state.
 * Renders the exact same AskThisData component the dashboard embeds; no separate query/answer system.
 */
function initialQuestionFromUrl(): string | undefined {
  if (typeof window === "undefined") return undefined;
  return new URLSearchParams(window.location.search).get("q") ?? undefined;
}

export function AskPageClient({ id }: { id: string }) {
  const [suggestedQuestions, setSuggestedQuestions] = useState<string[] | null>(null);
  // Read once, directly from the URL, in a lazy initializer — safe in a client component (only ever runs in the
  // browser) and avoids the Suspense boundary next/navigation's useSearchParams() would otherwise require here.
  const [initialQuestion] = useState(initialQuestionFromUrl);

  useEffect(() => {
    let cancelled = false;
    fetch(`/api/datasets/${id}`)
      .then((r) => r.json())
      .then((body) => {
        if (!cancelled) setSuggestedQuestions(body.suggestedQuestions ?? []);
      })
      .catch(() => !cancelled && setSuggestedQuestions([]));
    return () => {
      cancelled = true;
    };
  }, [id]);

  return (
    <div className="mx-auto w-full max-w-4xl flex-1 space-y-5 px-4 py-6 sm:px-6 lg:py-10">
      {suggestedQuestions === null ? <Skeleton className="h-48 rounded-2xl" /> : <AskThisData datasetId={id} suggestedQuestions={suggestedQuestions} initialQuestion={initialQuestion} />}
    </div>
  );
}
