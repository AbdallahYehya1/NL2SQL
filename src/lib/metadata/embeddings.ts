import { createHash } from "node:crypto";
import type pg from "pg";
import type { AIProvider } from "@/lib/ai/provider";
import { buildMetadataItems } from "./registry";
import type { MetadataItem } from "@/lib/types";

/**
 * pgvector integration: store one embedding per metadata item (table / column / metric) in
 * nl2sql.metadata_embeddings and query by cosine similarity. Optional — retrieval falls back to lexical.
 *
 * Every row belongs to exactly one dataset (`dataset_id`); every read and write below is filtered by it, so metadata of
 * one dataset can never be retrieved for another.
 */

export const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

export const toVectorLiteral = (v: number[]) => `[${v.map((x) => (Number.isFinite(x) ? x : 0)).join(",")}]`;

const DEMO = "demo";

export interface SyncResult {
  total: number;
  embedded: number;
  unchanged: number;
  removed: number;
}

/** Embed every registry item whose text (or embedding model) changed, and delete rows for removed items. */
export async function syncMetadataEmbeddings(
  pool: pg.Pool,
  provider: AIProvider,
  items: MetadataItem[] = buildMetadataItems(),
  batchSize = 32,
  datasetId: string = DEMO,
): Promise<SyncResult> {
  const model = provider.embeddingModel ?? "unknown";
  const existing = new Map<string, { hash: string; model: string }>();
  for (const r of (await pool.query("SELECT item_id, content_hash, model FROM nl2sql.metadata_embeddings WHERE dataset_id = $1", [datasetId])).rows) {
    existing.set(r.item_id, { hash: r.content_hash, model: r.model });
  }
  const stale = items.filter((i) => {
    const e = existing.get(i.id);
    return !e || e.hash !== sha256(i.text) || e.model !== model;
  });

  for (let i = 0; i < stale.length; i += batchSize) {
    const batch = stale.slice(i, i + batchSize);
    const vectors = await provider.embed(batch.map((b) => b.text));
    for (let j = 0; j < batch.length; j++) {
      const it = batch[j];
      await pool.query(
        `INSERT INTO nl2sql.metadata_embeddings (dataset_id, item_id, kind, table_name, column_name, content, content_hash, model, embedding, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::vector, now())
         ON CONFLICT (dataset_id, item_id) DO UPDATE SET kind=EXCLUDED.kind, table_name=EXCLUDED.table_name, column_name=EXCLUDED.column_name,
           content=EXCLUDED.content, content_hash=EXCLUDED.content_hash, model=EXCLUDED.model, embedding=EXCLUDED.embedding, updated_at=now()`,
        [datasetId, it.id, it.kind, it.table ?? null, it.column ?? null, it.text, sha256(it.text), model, toVectorLiteral(vectors[j])],
      );
    }
  }

  const keep = new Set(items.map((i) => i.id));
  const orphans = [...existing.keys()].filter((id) => !keep.has(id));
  if (orphans.length) await pool.query("DELETE FROM nl2sql.metadata_embeddings WHERE dataset_id = $1 AND item_id = ANY($2)", [datasetId, orphans]);

  return { total: items.length, embedded: stale.length, unchanged: items.length - stale.length, removed: orphans.length };
}

export interface VectorHit {
  itemId: string;
  similarity: number;
}

/** Nearest metadata items of ONE dataset by cosine similarity (1 = identical direction). */
export async function vectorSearch(pool: pg.Pool, queryEmbedding: number[], k = 30, model?: string, datasetId: string = DEMO): Promise<VectorHit[]> {
  const params: unknown[] = [toVectorLiteral(queryEmbedding), k, datasetId];
  if (model) params.push(model);
  const res = await pool.query(
    `SELECT item_id, 1 - (embedding <=> $1::vector) AS similarity
       FROM nl2sql.metadata_embeddings
      WHERE dataset_id = $3 ${model ? "AND model = $4" : ""}
      ORDER BY embedding <=> $1::vector
      LIMIT $2`,
    params,
  );
  return res.rows.map((r) => ({ itemId: r.item_id as string, similarity: Number(r.similarity) }));
}

export async function countEmbeddings(pool: pg.Pool, datasetId?: string): Promise<number> {
  if (datasetId) return (await pool.query("SELECT count(*)::int AS n FROM nl2sql.metadata_embeddings WHERE dataset_id = $1", [datasetId])).rows[0].n;
  return (await pool.query("SELECT count(*)::int AS n FROM nl2sql.metadata_embeddings")).rows[0].n;
}

export async function deleteDatasetEmbeddings(pool: pg.Pool, datasetId: string): Promise<void> {
  await pool.query("DELETE FROM nl2sql.metadata_embeddings WHERE dataset_id = $1", [datasetId]);
}
