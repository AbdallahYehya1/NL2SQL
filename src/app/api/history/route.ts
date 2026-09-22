import { NextResponse } from "next/server";
import { getAdminPool, isDatabaseConfigured } from "@/lib/database/client";
import { listHistory } from "@/lib/history/store";
import { getSessionId } from "@/lib/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Recent questions asked from this browser (scoped by an anonymous session cookie).
 * Filtered to one dataset (`?datasetId=`, default the built-in demo); `?datasetId=all` lists every dataset, and each entry
 * always says which dataset it belongs to.
 */
export async function GET(request: Request) {
  if (!isDatabaseConfigured()) return NextResponse.json({ runs: [] });
  const sessionId = await getSessionId(false);
  if (!sessionId) return NextResponse.json({ runs: [] });
  const datasetId = new URL(request.url).searchParams.get("datasetId") ?? "demo";
  try {
    return NextResponse.json({ runs: await listHistory(getAdminPool(), sessionId, 20, { datasetId }) });
  } catch {
    return NextResponse.json({ runs: [], error: "History is temporarily unavailable." }, { status: 503 });
  }
}
