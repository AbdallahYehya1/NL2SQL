import { NextResponse } from "next/server";
import { getAdminPool, isDatabaseConfigured } from "@/lib/database/client";
import { deleteDataset } from "@/lib/datasets/import-service";
import { ImportError } from "@/lib/datasets/limits";
import { DatasetError, canAccess, getDatasetDetails, getDatasetRow } from "@/lib/datasets/store";
import { getSessionId } from "@/lib/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Params = { params: Promise<{ id: string }> };

/** Dataset details: tables, columns, relationships, row counts, source type, suggested questions. */
export async function GET(_req: Request, { params }: Params) {
  const { id } = await params;
  if (!isDatabaseConfigured()) return NextResponse.json({ error: "Dataset not found." }, { status: 404 });
  try {
    return NextResponse.json(await getDatasetDetails(getAdminPool(), id, await getSessionId(false)));
  } catch (err) {
    if (err instanceof DatasetError) return NextResponse.json({ error: err.message }, { status: 404 });
    return NextResponse.json({ error: "Dataset unavailable." }, { status: 503 });
  }
}

/** Delete an uploaded dataset (owner only): drops its schema and read-only role, removes its embeddings. */
export async function DELETE(_req: Request, { params }: Params) {
  const { id } = await params;
  if (!isDatabaseConfigured()) return NextResponse.json({ error: "Dataset not found." }, { status: 404 });
  const pool = getAdminPool();
  const sessionId = await getSessionId(false);
  const row = await getDatasetRow(pool, id);
  if (!row || !canAccess(row, sessionId)) return NextResponse.json({ error: "Dataset not found." }, { status: 404 });
  try {
    await deleteDataset(pool, id);
    return NextResponse.json({ success: true });
  } catch (err) {
    if (err instanceof ImportError) return NextResponse.json({ error: err.message }, { status: err.httpStatus });
    return NextResponse.json({ error: "The dataset could not be deleted." }, { status: 500 });
  }
}
