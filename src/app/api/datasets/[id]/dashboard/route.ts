import { NextResponse } from "next/server";
import { getConfig } from "@/lib/config";
import { getAdminPool, isDatabaseConfigured } from "@/lib/database/client";
import { buildDashboard } from "@/lib/dashboard/engine";
import { DatasetError, loadDatasetContext } from "@/lib/datasets/store";
import { getSessionId } from "@/lib/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

type Params = { params: Promise<{ id: string }> };

/**
 * Computes the Data Dashboard for one dataset: deterministic KPIs, insights, visualizations, relationships and
 * quality metrics, plus (only if the AI provider is configured) a natural-language rewrite of the insights. Runs a
 * bounded number of read-only aggregation queries through the same validated/sandboxed pipeline every question uses
 * — see src/lib/dashboard/engine.ts.
 */
export async function GET(_req: Request, { params }: Params) {
  const { id } = await params;
  try {
    const pool = isDatabaseConfigured() ? getAdminPool() : undefined;
    const dataset = await loadDatasetContext(pool, id, await getSessionId(false));
    const data = await buildDashboard(dataset, getConfig());
    return NextResponse.json(data);
  } catch (err) {
    if (err instanceof DatasetError) {
      return NextResponse.json({ error: err.message }, { status: err.code === "not_ready" ? 409 : 404 });
    }
    console.error("[dashboard] failed to build dashboard:", err);
    return NextResponse.json({ error: "Could not build the dashboard for this dataset." }, { status: 500 });
  }
}
