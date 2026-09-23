import type { RateLimitInfo } from "@/lib/types";
import type { VisualizationSpec } from "@/components/charts/detect";

/**
 * The Data Dashboard's own types. Everything here is either a verified, traceable fact computed from the database
 * (KPI, InsightFact, quality numbers) or a thin reuse of an existing type (VisualizationSpec, RateLimitInfo) — see
 * docs comments in each engine module for exactly how each number is calculated.
 */

export type DashboardKpiFormat = "number" | "currency" | "percent" | "date" | "duration";

export interface DashboardKpi {
  id: string;
  label: string;
  /** Display-ready formatted value ("$284.6K", "180", "18 months"). */
  value: string;
  /** The underlying number, when there is one — for tests / future use (count-up animation etc). */
  rawValue?: number;
  format?: DashboardKpiFormat;
  description?: string;
  sourceTables: string[];
  sourceColumns: string[];
  /** Short human-readable description of the calculation, e.g. "SUM(orders.total_amount)". Never exposes SQL internals beyond this. */
  calculation?: string;
  /** Higher = more important; used only to pick the top N, never shown to the user. */
  priority: number;
}

export type InsightFactType = "TREND" | "PEAK" | "LOW" | "COMPARISON" | "DISTRIBUTION" | "CONCENTRATION" | "ANOMALY" | "DATA_QUALITY";

export interface InsightFact {
  id: string;
  type: InsightFactType;
  metric: string;
  value?: number;
  previousValue?: number;
  changePercent?: number;
  category?: string;
  period?: string;
  sourceTables: string[];
  sourceColumns: string[];
  confidence: "HIGH" | "MEDIUM";
  /**
   * A deterministic, template-generated natural-language sentence — built WITHOUT any AI call, directly from the
   * fields above. This is what's shown when AI rewriting is skipped, unavailable, or rate-limited; the optional AI
   * rewrite (see summary-engine.ts) may only rephrase this, never add a number that isn't already here.
   */
  statement: string;
  priority: number;
}

export interface DashboardVisualizationData {
  id: string;
  title: string;
  description?: string;
  spec: VisualizationSpec;
  columns: string[];
  rows: Record<string, unknown>[];
  sourceTables: string[];
  sourceColumns: string[];
}

export interface RelationshipEdge {
  fromTable: string;
  fromColumn: string;
  toTable: string;
  toColumn: string;
}

export interface DashboardRelationships {
  edges: RelationshipEdge[];
  /** Every table in the dataset, including ones with no edges (isolated nodes) — so the diagram never silently drops a table. */
  tables: string[];
}

export interface ColumnQuality {
  table: string;
  column: string;
  nullCount: number;
  nullPercent: number;
}

export interface DashboardQuality {
  totalRows: number;
  totalColumns: number;
  totalTables: number;
  /** Missing-value rate across the columns actually analyzed (see `coverage`) — never claims more than was measured. */
  overallMissingPercent: number;
  columnsWithMissing: ColumnQuality[];
  /** How many of the dataset's tables were actually included in the quality scan. */
  tablesAnalyzed: number;
  /** Honest statement of what was/wasn't covered — shown verbatim in the UI. */
  coverageNote: string;
}

export interface DashboardSummary {
  sentences: string[];
  source: "llm" | "deterministic";
}

export interface DashboardData {
  datasetId: string;
  datasetName: string;
  description?: string;
  tableCount: number;
  rowCount: number;
  columnCount: number;
  aiAvailable: boolean;
  kpis: DashboardKpi[];
  insights: InsightFact[];
  visualizations: DashboardVisualizationData[];
  relationships: DashboardRelationships;
  quality: DashboardQuality;
  summary: DashboardSummary;
  suggestedQuestions: string[];
  /** Same shape/meaning as QueryResponse.aiNotice (PR feature/groq-rate-limit-and-safety-ux) — the summary's AI rewrite specifically was unavailable; every deterministic section above is still fully populated. */
  aiNotice?: { code: "AI_UNAVAILABLE"; message: string } & Partial<RateLimitInfo>;
  /** Non-fatal: an optional section couldn't be computed (e.g. one table's aggregation query failed) but the rest of the dashboard is real. */
  warnings: string[];
}
