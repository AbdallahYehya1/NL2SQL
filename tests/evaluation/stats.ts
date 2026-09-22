/** Small statistics helpers so no evaluation rate is quoted without its uncertainty. */

/** 95 % Wilson score interval for k successes out of n trials, in percent (null when n = 0). */
export function wilson95(k: number, n: number): { rate: number; low: number; high: number } | null {
  if (n === 0) return null;
  const z = 1.96;
  const p = k / n;
  const denom = 1 + (z * z) / n;
  const centre = (p + (z * z) / (2 * n)) / denom;
  const half = (z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))) / denom;
  const r = (x: number) => Math.round(x * 1000) / 10;
  return { rate: r(p), low: r(Math.max(0, centre - half)), high: r(Math.min(1, centre + half)) };
}

export const formatRate = (k: number, n: number): string => {
  const w = wilson95(k, n);
  return w ? `${k}/${n} = ${w.rate}% (95% CI ${w.low}–${w.high}%)` : "n/a (0 cases)";
};
