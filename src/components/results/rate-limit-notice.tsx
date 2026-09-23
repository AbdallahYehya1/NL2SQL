"use client";

import { AlertTriangle, Clock, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useCountdown } from "@/lib/hooks/use-countdown";
import type { QueryResponse, RateLimitType } from "@/lib/types";

function limitCopy(limitType: RateLimitType | undefined): { title: string; body: string } {
  switch (limitType) {
    case "REQUESTS_PER_MINUTE":
    case "TOKENS_PER_MINUTE":
      return { title: "AI temporarily unavailable", body: "The AI provider's free tier hit its short-term usage limit. This resets on its own — try again in a moment." };
    case "REQUESTS_PER_DAY":
    case "TOKENS_PER_DAY":
      return { title: "AI temporarily unavailable", body: "The AI provider's free tier hit today's usage limit. It resets on a daily cycle, so please come back later." };
    default:
      return { title: "AI temporarily unavailable", body: "The AI provider is temporarily rate-limited. Please try again shortly." };
  }
}

/** Never a fake countdown: shows the real remaining time when we have a resetAt, otherwise a generic line, never a made-up number. */
function CountdownLine({ resetAt, retryAfterSeconds }: { resetAt?: string; retryAfterSeconds?: number }) {
  const remaining = useCountdown(resetAt);
  if (remaining === undefined) {
    return retryAfterSeconds === undefined ? <p className="text-sm text-muted-foreground">Please try again shortly.</p> : null;
  }
  return (
    <p className="flex items-center gap-1.5 text-sm font-medium tabular-nums text-foreground" aria-live="polite">
      <Clock className="h-3.5 w-3.5" aria-hidden />
      {remaining > 0 ? `You can try again in ${remaining}s` : "You can try again now"}
    </p>
  );
}

/**
 * Full replacement for a blocked response whose error is a rate limit — either this app's own per-client throttle
 * (RATE_LIMITED) or the AI provider's free-tier limit (PROVIDER_RATE_LIMIT, with real header-derived timing).
 * Retry is always manual (a click), never automatic or polled; the button is only guarded (not hidden) once we have
 * a confident countdown, so the user is never blocked from retrying when we're unsure.
 */
export function RateLimitBlocker({ error, onRetry }: { error: NonNullable<QueryResponse["error"]>; onRetry: () => void }) {
  const isAppLimit = error.code === "RATE_LIMITED";
  const { title, body } = isAppLimit
    ? { title: "Slow down a little", body: "You've asked several questions in a short time. Please wait a moment before trying again." }
    : limitCopy(error.limitType);
  const remaining = useCountdown(error.resetAt);
  const canRetry = remaining === undefined || remaining <= 0;

  return (
    <div role="status" className="animate-result-in space-y-3 rounded-2xl border border-border bg-card p-5 sm:p-6">
      <div className="flex items-center gap-2 text-foreground">
        <AlertTriangle className="h-4 w-4 text-warning" aria-hidden />
        <p className="text-sm font-semibold">{title}</p>
      </div>
      <p className="text-sm text-muted-foreground">{body}</p>
      <CountdownLine resetAt={error.resetAt} retryAfterSeconds={error.retryAfterSeconds} />
      <Button variant="outline" size="sm" onClick={onRetry} disabled={!canRetry}>
        <RefreshCw className="h-3.5 w-3.5" aria-hidden /> Try again
      </Button>
    </div>
  );
}

/** Small inline banner for the "query succeeded, only the AI explanation failed" case — the table/chart above stays fully visible. */
export function AiExplanationNotice({ notice, onRetry }: { notice: NonNullable<QueryResponse["aiNotice"]>; onRetry: () => void }) {
  const remaining = useCountdown(notice.resetAt);
  const canRetry = remaining === undefined || remaining <= 0;
  return (
    <div role="status" className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-warning/30 bg-warning-bg px-3 py-2 text-xs text-warning">
      <span>
        {notice.message}
        {remaining !== undefined && remaining > 0 ? ` Try again in ${remaining}s.` : ""}
      </span>
      <Button variant="ghost" size="sm" onClick={onRetry} disabled={!canRetry} className="h-6 px-2 text-xs">
        <RefreshCw className="h-3 w-3" aria-hidden /> Try again
      </Button>
    </div>
  );
}
