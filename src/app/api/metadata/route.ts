import { NextResponse } from "next/server";
import { getAdminPool, isDatabaseConfigured } from "@/lib/database/client";
import { DatasetError, loadDatasetContext } from "@/lib/datasets/store";
import { DEMO_DATASET_ID } from "@/lib/datasets/context";
import { getSessionId } from "@/lib/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Description of a dataset's metadata registry: tables, columns, relationships and business metrics.
 * `?datasetId=` selects the dataset (default: the built-in demo); uploaded datasets are only visible to their owner.
 */
export async function GET(request: Request) {
  const id = new URL(request.url).searchParams.get("datasetId") ?? DEMO_DATASET_ID;
  let dataset;
  try {
    const pool = id !== DEMO_DATASET_ID && isDatabaseConfigured() ? getAdminPool() : undefined;
    dataset = await loadDatasetContext(pool, id, await getSessionId(false));
  } catch (err) {
    return NextResponse.json({ error: err instanceof DatasetError ? err.message : "Dataset unavailable." }, { status: err instanceof DatasetError && err.code === "not_ready" ? 409 : 404 });
  }
  const reg = dataset.registry;
  return NextResponse.json({
    dataset: { id: dataset.id, name: dataset.name },
    tables: reg.tables.map((t) => ({
      name: t.name,
      domain: t.domain,
      description: t.description,
      synonyms: t.synonyms,
      columns: t.columns.map((c) => ({ name: c.name, type: c.type, description: c.description, primaryKey: !!c.primaryKey, references: c.references ?? null })),
    })),
    relationships: reg.relationships,
    metrics: reg.metrics.map((m) => ({ name: m.name, description: m.description, definition: m.definition })),
    defaults: reg.defaults,
  });
}
