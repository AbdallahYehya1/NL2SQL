"use client";

import { useEffect, useState } from "react";
import { Skeleton } from "@/components/ui/skeleton";
import { useReducedMotion } from "@/lib/hooks/use-reduced-motion";

const STAGES = ["Analyzing your data…", "Finding useful patterns…", "Preparing your dashboard…"];
const STAGE_AT_MS = [200, 1400, 3200];

/** Contextual loading stages instead of a blank page — never shows fake metrics, only skeleton placeholders. */
export function DashboardSkeleton() {
  const reducedMotion = useReducedMotion();
  const [stage, setStage] = useState(0);

  useEffect(() => {
    if (reducedMotion) return;
    const timers = STAGE_AT_MS.map((ms, i) => setTimeout(() => setStage((s) => Math.max(s, i)), ms));
    return () => timers.forEach(clearTimeout);
  }, [reducedMotion]);

  return (
    <div className="space-y-5" role="status" aria-live="polite">
      <p className="text-sm font-medium text-muted-foreground">{STAGES[stage]}</p>
      <Skeleton className="h-24 w-full rounded-2xl" />
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        {Array.from({ length: 4 }).map((_, i) => (
          <Skeleton key={i} className="h-20 rounded-2xl" />
        ))}
      </div>
      <Skeleton className="h-24 w-full rounded-2xl" />
      <Skeleton className="h-64 w-full rounded-2xl" />
    </div>
  );
}
