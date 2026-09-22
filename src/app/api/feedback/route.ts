import { NextResponse } from "next/server";
import { z } from "zod";
import { getAdminPool, isDatabaseConfigured } from "@/lib/database/client";
import { saveFeedback } from "@/lib/history/store";
import { getSessionId } from "@/lib/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const Body = z.object({
  runId: z.string().uuid(),
  rating: z.union([z.literal(1), z.literal(-1)]),
  comment: z.string().max(500).optional(),
});

/** Thumbs up/down on an answer. Only the session that created the run may rate it. */
export async function POST(request: Request) {
  const parsed = Body.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ success: false, error: "Invalid feedback payload." }, { status: 400 });
  if (!isDatabaseConfigured()) return NextResponse.json({ success: false, error: "Database not configured." }, { status: 503 });
  const sessionId = await getSessionId(false);
  if (!sessionId) return NextResponse.json({ success: false, error: "Unknown session." }, { status: 403 });
  const ok = await saveFeedback(getAdminPool(), sessionId, parsed.data.runId, parsed.data.rating, parsed.data.comment).catch(() => false);
  return NextResponse.json({ success: ok }, { status: ok ? 200 : 404 });
}
