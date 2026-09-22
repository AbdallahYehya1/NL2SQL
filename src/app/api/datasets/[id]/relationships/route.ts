import { NextResponse } from "next/server";
import { z } from "zod";
import { getProvider } from "@/lib/ai/provider";
import { getAdminPool, isDatabaseConfigured } from "@/lib/database/client";
import { confirmRelationships } from "@/lib/datasets/import-service";
import { ImportError } from "@/lib/datasets/limits";
import { canAccess, getDatasetDetails, getDatasetRow } from "@/lib/datasets/store";
import { getSessionId } from "@/lib/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const Body = z.object({
  confirm: z.array(z.object({ fromTable: z.string(), fromColumn: z.string(), toTable: z.string(), toColumn: z.string() })).max(60),
  dismissRest: z.boolean().optional().default(false),
});

/**
 * CSV datasets: confirm which SUGGESTED relationships are real. Confirmed ones become genuine foreign keys (and appear in
 * the metadata); everything not confirmed stays out of the metadata. Only suggestions the server generated can be confirmed.
 */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const parsed = Body.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "Invalid request." }, { status: 400 });
  if (!isDatabaseConfigured()) return NextResponse.json({ error: "Dataset not found." }, { status: 404 });
  const pool = getAdminPool();
  const sessionId = await getSessionId(false);
  const row = await getDatasetRow(pool, id);
  if (!row || !canAccess(row, sessionId) || row.session_id === null) return NextResponse.json({ error: "Dataset not found." }, { status: 404 });
  try {
    await confirmRelationships(pool, id, parsed.data.confirm, parsed.data.dismissRest, { provider: getProvider() });
    return NextResponse.json(await getDatasetDetails(pool, id, sessionId));
  } catch (err) {
    if (err instanceof ImportError) return NextResponse.json({ error: err.message }, { status: err.httpStatus });
    return NextResponse.json({ error: "The relationships could not be saved." }, { status: 500 });
  }
}
