"use client";

import { useEffect, useState } from "react";

const remainingSeconds = (resetAt: string) => Math.max(0, Math.ceil((new Date(resetAt).getTime() - Date.now()) / 1000));

/**
 * Live seconds-remaining until `resetAt` (an ISO timestamp), ticking once a second, floored at 0. Returns undefined
 * when `resetAt` isn't provided — callers must never invent a countdown when the provider didn't give a real reset
 * time; they should show a generic "try again shortly" message instead.
 */
export function useCountdown(resetAt: string | undefined): number | undefined {
  const [seconds, setSeconds] = useState(() => (resetAt ? remainingSeconds(resetAt) : undefined));
  const [prevResetAt, setPrevResetAt] = useState(resetAt);

  // A new resetAt (e.g. the user retried and got rate-limited again) restarts the countdown immediately, during render.
  if (resetAt !== prevResetAt) {
    setPrevResetAt(resetAt);
    setSeconds(resetAt ? remainingSeconds(resetAt) : undefined);
  }

  useEffect(() => {
    if (!resetAt) return;
    const id = setInterval(() => setSeconds(remainingSeconds(resetAt)), 1000);
    return () => clearInterval(id);
  }, [resetAt]);

  return seconds;
}
