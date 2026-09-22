import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { getAdminPool, isDatabaseConfigured } from "@/lib/database/client";
import { canAccess, getDatasetRow, listDatasets } from "@/lib/datasets/store";
import { getSessionId } from "@/lib/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Make a dataset the active one for this browser ("Use This Dataset"). The active dataset is only a UI default:
 * every /api/query request still names its dataset explicitly, and the server re-checks ownership and status each time.
 */
export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!isDatabaseConfigured()) return NextResponse.json({ error: "Dataset not found." }, { status: 404 });
  const pool = getAdminPool();
  const sessionId = await getSessionId(true);
  const row = await getDatasetRow(pool, id);
  if (!row || !canAccess(row, sessionId)) return NextResponse.json({ error: "Dataset not found." }, { status: 404 });
  if (row.status !== "ready") return NextResponse.json({ error: "Only a ready dataset can be activated." }, { status: 409 });
  (await cookies()).set("nl2sql_dataset", id, { httpOnly: true, sameSite: "lax", secure: process.env.NODE_ENV === "production", path: "/", maxAge: 60 * 60 * 24 * 30 });
  const dataset = (await listDatasets(pool, sessionId)).find((d) => d.id === id);
  return NextResponse.json({ success: true, dataset });
}
