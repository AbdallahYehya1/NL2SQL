"use client";

import { TriangleAlert } from "lucide-react";
import { useEffect, useState } from "react";

interface Health {
  ok: boolean;
  ai: { provider: string; model: string | null; configured: boolean };
  database: { configured: boolean; reachable: boolean };
  retrieval: string;
}

/** Shows actionable setup problems (missing DATABASE_URL / AI key) instead of failing on the first question. */
export function StatusBanner({ onHealth }: { onHealth?: (h: Health | null) => void }) {
  const [health, setHealth] = useState<Health | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/health")
      .then((r) => r.json())
      .then((h: Health) => {
        if (cancelled) return;
        setHealth(h);
        onHealth?.(h);
      })
      .catch(() => onHealth?.(null));
    return () => {
      cancelled = true;
    };
  }, [onHealth]);

  if (!health || health.ok) return null;
  const problems: string[] = [];
  if (!health.database.configured) problems.push("DATABASE_URL is not set.");
  else if (!health.database.reachable) problems.push("The database could not be reached. Check DATABASE_URL and run the migrations.");
  if (!health.ai.configured) problems.push("The AI provider is not configured. Set AI_PROVIDER, AI_MODEL and AI_API_KEY.");

  return (
    <div role="alert" className="flex items-start gap-3 rounded-xl border border-warning/40 bg-warning-bg p-3 text-sm text-warning">
      <TriangleAlert className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
      <div>
        <p className="font-medium">Setup incomplete</p>
        <ul className="list-inside list-disc">
          {problems.map((p) => (
            <li key={p}>{p}</li>
          ))}
        </ul>
        <p className="mt-1 text-xs">See the README (Local setup) for the exact steps.</p>
      </div>
    </div>
  );
}
