"use client";

import { useEffect, useRef, useState } from "react";
import { useReducedMotion } from "./use-reduced-motion";

const easeOutCubic = (t: number) => 1 - Math.pow(1 - t, 3);

/** Animates from 0 (or the previous value) to `target` over `durationMs`. Instant when reduced motion is requested. */
export function useCountUp(target: number, durationMs = 700): number {
  const reduced = useReducedMotion();
  const [value, setValue] = useState(target);
  const frame = useRef<number>(0);
  const prevTarget = useRef(target);

  useEffect(() => {
    if (reduced || !Number.isFinite(target)) return;
    const from = prevTarget.current === target ? 0 : value;
    const start = performance.now();
    cancelAnimationFrame(frame.current);
    const tick = (now: number) => {
      const t = Math.min(1, (now - start) / durationMs);
      setValue(from + (target - from) * easeOutCubic(t));
      if (t < 1) frame.current = requestAnimationFrame(tick);
      else setValue(target);
    };
    frame.current = requestAnimationFrame(tick);
    prevTarget.current = target;
    return () => cancelAnimationFrame(frame.current);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [target, durationMs, reduced]);

  // Reduced motion (or a non-finite target) bypasses the animated state entirely, so it's always in sync — never
  // stale — instead of relying on useState's one-time initializer to happen to match a later target.
  if (reduced || !Number.isFinite(target)) return target;
  return value;
}
