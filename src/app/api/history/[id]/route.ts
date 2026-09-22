import { NextResponse } from "next/server";
import { getAdminPool, isDatabaseConfigured } from "@/lib/database/client";
import { getRun } from "@/lib/history/store";
import { getSessionId } from "@/lib/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const UUID = /^[0-9a-f-]{36}$/i;

/** One stored run including its agent trace (only if it belongs to this browser session). */
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!UUID.test(id) || !isDatabaseConfigured()) return NextResponse.json({ error: "Not found" }, { status: 404 });
  const sessionId = await getSessionId(false);
  if (!sessionId) return NextResponse.json({ error: "Not found" }, { status: 404 });
  const run = await getRun(getAdminPool(), sessionId, id).catch(() => undefined);
  if (!run) return NextResponse.json({ error: "Not found" }, { status: 404 });
  return NextResponse.json({
    id: run.id,
    question: run.user_question,
    status: run.status,
    sql: run.generated_sql,
    tablesUsed: run.tables_used,
    columnsUsed: run.columns_used,
    attempts: run.attempt_count,
    answer: run.answer,
    error: run.error,
    rowCount: run.row_count,
    executionTimeMs: run.execution_time_ms,
    totalLatencyMs: run.total_latency_ms,
    provider: run.provider,
    model: run.model,
    trace: run.trace,
    createdAt: run.created_at,
  });
}
