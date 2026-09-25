import { Sparkles } from "lucide-react";
import { AiExplanationNotice } from "@/components/results/rate-limit-notice";
import { Card, CardContent } from "@/components/ui/card";
import type { DashboardData } from "@/lib/dashboard/types";

export function SummarySection({ data, onRetry }: { data: DashboardData; onRetry: () => void }) {
  return (
    <Card>
      <CardContent className="animate-result-in space-y-3">
        {data.aiNotice && <AiExplanationNotice notice={data.aiNotice} onRetry={onRetry} />}
        <div className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-primary">
          <Sparkles className="h-3.5 w-3.5" aria-hidden />
          What stands out
        </div>
        <div className="space-y-1.5">
          {data.summary.sentences.map((s, i) => (
            <p key={i} className={i === 0 ? "text-lg font-medium leading-relaxed text-foreground sm:text-xl" : "text-sm text-muted-foreground"}>
              {s}
            </p>
          ))}
        </div>
      </CardContent>
    </Card>
  );
}
