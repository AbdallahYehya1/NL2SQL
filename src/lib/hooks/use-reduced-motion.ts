"use client";

import { useEffect, useState } from "react";

function currentlyReduced(): boolean {
  return typeof window !== "undefined" && typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

/** True when the user's OS/browser asks for reduced motion. Count-up, chart-draw and stagger animations all check this. */
export function useReducedMotion(): boolean {
  // Lazy initial state: correct from the very first render, no flash of the wrong value and no synchronous setState in an effect.
  const [reduced, setReduced] = useState(currentlyReduced);
  useEffect(() => {
    if (typeof window === "undefined" || !window.matchMedia) return;
    const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
    const onChange = () => setReduced(mq.matches);
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, []);
  return reduced;
}
