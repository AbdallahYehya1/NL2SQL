import { formatNumberCompact, formatNumberFull, looksLikeCurrency, titleCase } from "@/lib/format";
import type { DashboardAnalysis } from "./analyze";
import type { DashboardQuality } from "./types";
import type { InsightFact } from "./types";

/**
 * Every InsightFact's `value`/`previousValue`/`changePercent`/etc. is read directly off analyze.ts's query results —
 * nothing here is computed by an LLM. `statement` is a deterministic template sentence built from those same numbers,
 * so an insight is always safe to display even when the (optional) AI rewrite in summary-engine.ts is unavailable.
 * A candidate is only ever emitted when the underlying numbers actually support it (see the guards in each builder).
 */

const fmt = (n: number, currency: boolean) => (currency ? `$${formatNumberCompact(n)}` : formatNumberFull(Math.round(n * 100) / 100));

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/**
 * Unlike lib/format.ts's formatDateLabel (a compact chart-axis label that deliberately omits the year), an insight
 * sentence can span multiple years — "Sep 2023" and "Sep 2025" must never both collapse to the same "Sep 1" label.
 */
function periodLabel(period: unknown, granularity: "month" | "year"): string {
  if (granularity === "year") return String(period);
  const s = String(period);
  const m = s.match(/^(\d{4})-(\d{2})/);
  if (!m) return s;
  const month = MONTHS[Number(m[2]) - 1] ?? m[2];
  return `${month} ${m[1]}`;
}

let seq = 0;
const nextId = (prefix: string) => `${prefix}-${++seq}`;

function peakAndLow(analysis: DashboardAnalysis): InsightFact[] {
  const ts = analysis.timeSeries;
  if (!ts || ts.rows.length < 3) return [];
  const metric = ts.measureCol ? titleCase(ts.measureCol.name) : `Number of ${titleCase(ts.sourceTable.name)}`;
  const isCurrency = ts.measureCol ? looksLikeCurrency(ts.measureCol.name) : false;
  const sourceColumns = [ts.dateCol.name, ...(ts.measureCol ? [ts.measureCol.name] : [])];

  const withValues = ts.rows.filter((r) => Number.isFinite(r.value));
  if (withValues.length < 3) return [];
  const peak = withValues.reduce((a, r) => (r.value > a.value ? r : a));
  const low = withValues.reduce((a, r) => (r.value < a.value ? r : a));

  const facts: InsightFact[] = [];
  if (peak !== low) {
    facts.push({
      id: nextId("peak"),
      type: "PEAK",
      metric,
      value: peak.value,
      period: periodLabel(peak.period, ts.granularity),
      sourceTables: [ts.sourceTable.name],
      sourceColumns,
      confidence: "HIGH",
      statement: `${periodLabel(peak.period, ts.granularity)} recorded the highest ${metric.toLowerCase()}, at ${fmt(peak.value, isCurrency)}.`,
      priority: 90,
    });
    facts.push({
      id: nextId("low"),
      type: "LOW",
      metric,
      value: low.value,
      period: periodLabel(low.period, ts.granularity),
      sourceTables: [ts.sourceTable.name],
      sourceColumns,
      confidence: "HIGH",
      statement: `${periodLabel(low.period, ts.granularity)} had the lowest ${metric.toLowerCase()}, at ${fmt(low.value, isCurrency)}.`,
      priority: 40,
    });
  }
  return facts;
}

/** Direction from the first third of the series to the last third — only reported when it's reasonably consistent, not just noisy. */
function trend(analysis: DashboardAnalysis): InsightFact[] {
  const ts = analysis.timeSeries;
  if (!ts || ts.rows.length < 4) return [];
  const values = ts.rows.map((r) => r.value).filter(Number.isFinite);
  if (values.length < 4) return [];

  const third = Math.max(1, Math.floor(values.length / 3));
  const first = values.slice(0, third);
  const last = values.slice(-third);
  const firstAvg = first.reduce((a, b) => a + b, 0) / first.length;
  const lastAvg = last.reduce((a, b) => a + b, 0) / last.length;
  if (firstAvg === 0) return [];
  const changePercent = ((lastAvg - firstAvg) / Math.abs(firstAvg)) * 100;
  if (Math.abs(changePercent) < 10) return []; // not a meaningful trend

  let ups = 0, downs = 0;
  for (let i = 1; i < values.length; i++) {
    if (values[i] > values[i - 1]) ups++;
    else if (values[i] < values[i - 1]) downs++;
  }
  const total = ups + downs;
  if (total === 0) return [];
  const consistency = Math.max(ups, downs) / total;
  if (consistency < 0.55) return []; // too noisy to call it a trend

  const metric = ts.measureCol ? titleCase(ts.measureCol.name) : `Number of ${titleCase(ts.sourceTable.name)}`;
  const direction = changePercent > 0 ? "increased" : "decreased";
  const startLabel = periodLabel(ts.rows[0].period, ts.granularity);
  const endLabel = periodLabel(ts.rows[ts.rows.length - 1].period, ts.granularity);
  return [
    {
      id: nextId("trend"),
      type: "TREND",
      metric,
      value: lastAvg,
      previousValue: firstAvg,
      changePercent: Math.round(changePercent * 10) / 10,
      period: `${startLabel}–${endLabel}`,
      sourceTables: [ts.sourceTable.name],
      sourceColumns: [ts.dateCol.name, ...(ts.measureCol ? [ts.measureCol.name] : [])],
      confidence: consistency >= 0.8 ? "HIGH" : "MEDIUM",
      statement: `${metric} ${direction} from ${startLabel} through ${endLabel}, by about ${Math.abs(Math.round(changePercent))}%.`,
      priority: consistency >= 0.8 ? 85 : 65,
    },
  ];
}

/** One insight from a category breakdown: prefers a concentration statement, falls back to a comparison, then a plain distribution note. */
function categoryInsight(cb: DashboardAnalysis["categoryBreakdown"]): InsightFact | undefined {
  if (!cb || cb.rows.length < 2) return undefined;
  const rows = cb.rows.filter((r) => Number.isFinite(r.value) && r.value >= 0);
  if (rows.length < 2) return undefined;
  const total = rows.reduce((a, r) => a + r.value, 0);
  if (total <= 0) return undefined;

  const sorted = [...rows].sort((a, b) => b.value - a.value);
  const metric = cb.measureCol ? titleCase(cb.measureCol.name) : `Number of ${titleCase(cb.sourceTable.name)}`;
  const sourceColumns = [cb.categoryCol.name, ...(cb.measureCol ? [cb.measureCol.name] : [])];
  const top = sorted[0];
  const topShare = (top.value / total) * 100;

  const topN = Math.min(3, sorted.length);
  const topNShare = (sorted.slice(0, topN).reduce((a, r) => a + r.value, 0) / total) * 100;
  // "3 of many dominate" is only a meaningful story when there are meaningfully more than 3 categories in the first
  // place — with few categories, the top 3 accounting for most of the total is close to tautological, not a finding.
  if (sorted.length >= 6 && topN < sorted.length && topNShare >= 40) {
    return {
      id: nextId("concentration"),
      type: "CONCENTRATION",
      metric,
      value: topNShare,
      category: sorted.slice(0, topN).map((r) => String(r.category)).join(", "),
      sourceTables: [cb.sourceTable.name],
      sourceColumns,
      confidence: "HIGH",
      statement: `${topN} ${titleCase(cb.categoryCol.name).toLowerCase()} groups (${sorted.slice(0, topN).map((r) => String(r.category)).join(", ")}) account for about ${Math.round(topNShare)}% of total ${metric.toLowerCase()}.`,
      priority: 80,
    };
  }

  if (sorted.length >= 2) {
    const second = sorted[1];
    if (second.value > 0) {
      const diffPercent = ((top.value - second.value) / second.value) * 100;
      // An upper bound matters as much as the lower one: a SUM-based comparison between categories with very
      // different row counts (e.g. 10,000 "delivered" shipments vs. 5 "in transit" ones) can produce a technically
      // true but wildly misleading "7,000% more" claim that's really just a volume artifact, not a rate difference.
      // Past this point the topN-share framing below (concentration/distribution) is the honest way to describe it.
      if (diffPercent >= 10 && diffPercent <= 300) {
        return {
          id: nextId("comparison"),
          type: "COMPARISON",
          metric,
          value: top.value,
          previousValue: second.value,
          changePercent: Math.round(diffPercent * 10) / 10,
          category: String(top.category),
          sourceTables: [cb.sourceTable.name],
          sourceColumns,
          confidence: "HIGH",
          statement: `${String(top.category)} generated about ${Math.round(diffPercent)}% more ${metric.toLowerCase()} than ${String(second.category)}, the next highest.`,
          priority: 75,
        };
      }
    }
  }

  // A "most of X is Y" story only holds up when the leader is clearly ahead of what an even split would give every
  // category — otherwise (e.g. 25% each of 4 categories) the "top" one is just tied, not dominant.
  const evenShare = 100 / sorted.length;
  if (topShare >= 25 && topShare > evenShare * 1.3) {
    return {
      id: nextId("distribution"),
      type: "DISTRIBUTION",
      metric,
      value: topShare,
      category: String(top.category),
      sourceTables: [cb.sourceTable.name],
      sourceColumns,
      confidence: "MEDIUM",
      statement: `Most of the ${metric.toLowerCase()} is associated with ${String(top.category)}, about ${Math.round(topShare)}% of the total.`,
      priority: 55,
    };
  }

  return undefined;
}

function qualityInsight(quality: DashboardQuality | undefined): InsightFact | undefined {
  if (!quality || quality.columnsWithMissing.length === 0) return undefined;
  const worst = [...quality.columnsWithMissing].sort((a, b) => b.nullPercent - a.nullPercent)[0];
  if (worst.nullPercent < 1) return undefined;
  return {
    id: nextId("quality"),
    type: "DATA_QUALITY",
    metric: `${worst.table}.${worst.column} missing values`,
    value: worst.nullPercent,
    sourceTables: [worst.table],
    sourceColumns: [worst.column],
    confidence: "HIGH",
    statement: `The ${worst.column} column contains missing values in about ${worst.nullPercent}% of rows.`,
    priority: 50,
  };
}

const MAX_INSIGHTS = 5;

export function buildInsights(analysis: DashboardAnalysis, quality?: DashboardQuality): InsightFact[] {
  const candidates: InsightFact[] = [...peakAndLow(analysis), ...trend(analysis)];
  // Each breakdown (the primary table's main dimension, a second dimension on it, and one from elsewhere in the
  // schema) is a genuinely different fact, not a restatement — a lower priority is given to later ones only so the
  // single strongest story leads, not to suppress real findings from the other dimensions.
  const breakdowns: [DashboardAnalysis["categoryBreakdown"], number][] = [
    [analysis.categoryBreakdown, 0],
    [analysis.secondaryCategoryBreakdown, -8],
    [analysis.supportingBreakdown, -4],
  ];
  for (const [cb, penalty] of breakdowns) {
    const fact = categoryInsight(cb);
    if (fact) candidates.push({ ...fact, priority: fact.priority + penalty });
  }
  const q = qualityInsight(quality);
  if (q) candidates.push(q);

  return candidates.sort((a, b) => b.priority - a.priority).slice(0, MAX_INSIGHTS);
}
