"use client";

import { Sparkles } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { QueryInput } from "@/components/query-input/query-input";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

/**
 * A compact, prominent entry point into the dataset's real ask flow (/datasets/[id]/ask) — not a second question-
 * answering system. Typing here and submitting just navigates there with the question pre-filled; the actual
 * NL2SQL call happens only once, on that page (see AskThisData / ask-page-client.tsx).
 */
export function AskTeaser({ datasetId, suggestedQuestions }: { datasetId: string; suggestedQuestions: string[] }) {
  const router = useRouter();
  const [question, setQuestion] = useState("");

  function go(q: string) {
    router.push(`/datasets/${datasetId}/ask?q=${encodeURIComponent(q)}`);
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Sparkles className="h-4 w-4 text-primary" aria-hidden /> Ask this data
        </CardTitle>
      </CardHeader>
      <CardContent>
        <QueryInput value={question} onChange={setQuestion} onSubmit={go} loading={false} examples={suggestedQuestions} placeholder={suggestedQuestions[0] ?? "What would you like to know?"} />
      </CardContent>
    </Card>
  );
}
