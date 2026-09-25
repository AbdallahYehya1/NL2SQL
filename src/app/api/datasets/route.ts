import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { getAdminPool, isDatabaseConfigured } from "@/lib/database/client";
import { listDatasets } from "@/lib/datasets/store";
import { getUploadLimits } from "@/lib/datasets/limits";
import { getSessionId } from "@/lib/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** The built-in demo plus the datasets this browser session uploaded, and the currently active dataset id. */
export async function GET() {
  if (!isDatabaseConfigured()) return NextResponse.json({ datasets: [], activeId: "demo", limits: publicLimits() });
  const sessionId = await getSessionId(false);
  try {
    const datasets = await listDatasets(getAdminPool(), sessionId);
    const active = (await cookies()).get("nl2sql_dataset")?.value;
    const activeId = datasets.some((d) => d.id === active && d.status === "ready") ? active! : "demo";
    return NextResponse.json({ datasets, activeId, limits: publicLimits() });
  } catch {
    return NextResponse.json({ datasets: [], activeId: "demo", error: "Datasets are temporarily unavailable." }, { status: 503 });
  }
}

function publicLimits() {
  const l = getUploadLimits();
  return {
    maxRequestMb: l.maxRequestBytes / 1024 / 1024,
    maxChunkMb: l.maxChunkBytes / 1024 / 1024,
    maxSqlMb: l.maxSqlBytes / 1024 / 1024,
    maxCsvMb: l.maxCsvBytes / 1024 / 1024,
    maxFiles: l.maxFiles,
    maxTables: l.maxTables,
    maxColumnsPerTable: l.maxColumnsPerTable,
    maxRows: l.maxRows,
    maxDatasetsPerSession: l.maxDatasetsPerSession,
    ttlHours: l.ttlHours,
  };
}
