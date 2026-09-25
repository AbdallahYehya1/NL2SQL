import type { AIProvider } from "@/lib/ai/provider";
import { getProvider } from "@/lib/ai/provider";
import type { AppConfig } from "@/lib/config";
import type { DatasetContext } from "@/lib/datasets/context";
import { suggestQuestions } from "@/lib/datasets/suggestions";
import { analyzeDataset } from "./analyze";
import { selectKpis } from "./kpi-engine";
import { buildInsights } from "./insight-engine";
import { buildVisualizations } from "./visualization-engine";
import { buildQuality } from "./quality-engine";
import { buildRelationships } from "./relationship-engine";
import { buildSummary } from "./summary-engine";
import type { QueryExecutor } from "./query-runner";
import type { DashboardData } from "./types";

/**
 * Top-level pipeline: ACTUAL DATABASE → METADATA → DETERMINISTIC ANALYSIS → VERIFIED FACTS → VISUALIZATION →
 * optional AI wording. Every section below (kpis/insights/visualizations/relationships/quality) is fully computed
 * BEFORE the one optional AI call (the summary rewrite), and none of them depend on it — the dashboard is complete
 * and correct even when AI is unavailable, which the `aiNotice` field (mirroring QueryResponse.aiNotice) makes explicit.
 */
export interface BuildDashboardOptions {
  execute?: QueryExecutor;
  provider?: AIProvider;
}

export async function buildDashboard(dataset: DatasetContext, config: AppConfig, opts: BuildDashboardOptions = {}): Promise<DashboardData> {
  const analysis = await analyzeDataset(dataset, config, opts.execute);
  const kpis = selectKpis(analysis);
  const quality = buildQuality(analysis);
  const insights = buildInsights(analysis, quality);
  const visualizations = buildVisualizations(analysis);
  const relationships = buildRelationships(dataset);

  // Same "is the AI provider configured" check as /api/health — never an AI call just to answer this boolean.
  const aiAvailable = Boolean(config.ai.model && (config.ai.apiKey || config.ai.provider === "ollama" || config.ai.provider === "custom"));
  const provider = aiAvailable ? (opts.provider ?? getProvider()) : undefined;
  const { summary, notice } = await buildSummary(insights, provider, config.summaryMode);

  const rowCount = analysis.allTables.reduce((a, t) => a + (t.rowCount ?? 0), 0);
  const columnCount = analysis.allTables.reduce((a, t) => a + t.columns.length, 0);

  return {
    datasetId: dataset.id,
    datasetName: dataset.name,
    description: dataset.description,
    tableCount: analysis.allTables.length,
    rowCount,
    columnCount,
    aiAvailable,
    kpis,
    insights,
    visualizations,
    relationships,
    quality,
    summary,
    suggestedQuestions: dataset.suggestedQuestions ?? suggestQuestions(dataset.registry),
    aiNotice: notice ? { code: "AI_UNAVAILABLE", ...notice } : undefined,
    warnings: analysis.warnings,
  };
}
