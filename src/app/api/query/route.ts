import { NextResponse } from "next/server";
import { getConfig } from "@/lib/config";
import { getAdminPool, isDatabaseConfigured } from "@/lib/database/client";
import { isRateLimited } from "@/lib/history/store";
import { getClientHash, getSessionId, httpStatusFor } from "@/lib/http";
import { processQuestion } from "@/lib/nl2sql/orchestrator";
import type { QueryResponse } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

function failure(status: number, code: string, message: string) {
  return NextResponse.json({ success: false, status: "error", answer: message, error: { code, message } }, { status });
}

export async function POST(request: Request) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return failure(400, "EMPTY_QUESTION", "Send a JSON body like {\"question\": \"...\"}.");
  }
  const { question, datasetId } = (body as { question?: unknown; datasetId?: unknown } | null) ?? {};
  // The dataset is chosen explicitly by the client. A missing datasetId means the built-in demo dataset (documented default).
  const dataset = typeof datasetId === "string" && datasetId ? datasetId : "demo";

  if (!isDatabaseConfigured()) {
    return failure(503, "DATABASE_UNAVAILABLE", "The database is not configured. Set DATABASE_URL (see README).");
  }

  const sessionId = await getSessionId(true);
  const clientHash = await getClientHash();
  const cfg = getConfig();
  try {
    if (await isRateLimited(getAdminPool(), clientHash, cfg.limits.rateLimitPerMinute)) {
      return failure(429, "RATE_LIMITED", "Too many questions in a short time. Please wait a minute and try again.");
    }
  } catch {
    return failure(503, "DATABASE_UNAVAILABLE", "The database is temporarily unavailable. Please try again shortly.");
  }

  const result: QueryResponse = await processQuestion({ question, datasetId: dataset }, { sessionId, clientHash, datasetId: dataset });
  return NextResponse.json(result, { status: httpStatusFor(result.error?.code) });
}
