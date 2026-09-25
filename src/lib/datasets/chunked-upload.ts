import type pg from "pg";
import type { UploadedFile } from "./import-service";
import { ImportError, type UploadLimits } from "./limits";

/**
 * Staging for large uploads: Vercel serverless functions reject request bodies over 4.5 MB, so a file above
 * limits.maxRequestBytes is split into chunks client-side and POSTed one request at a time (each well under that
 * ceiling), landing in nl2sql.upload_chunks. Once every chunk for every file has arrived, reassembleFiles() hands
 * back the exact same UploadedFile[] shape importDataset() already accepts — the import pipeline itself is
 * completely unaware chunking happened.
 */

export interface StoreChunkInput {
  uploadId: string;
  sessionId: string;
  fileIndex: number;
  fileName: string;
  chunkIndex: number;
  totalChunks: number;
  bytes: Buffer;
}

/** Idempotent: re-sending the same (uploadId, fileIndex, chunkIndex) overwrites rather than duplicating, so a client retry after a dropped connection is always safe. */
export async function storeChunk(pool: pg.Pool, input: StoreChunkInput, limits: UploadLimits): Promise<void> {
  if (!Number.isInteger(input.totalChunks) || input.totalChunks < 1) throw new ImportError("Invalid upload metadata.", [], 400);
  if (!Number.isInteger(input.chunkIndex) || input.chunkIndex < 0 || input.chunkIndex >= input.totalChunks) throw new ImportError("Invalid chunk index.", [], 400);
  if (input.bytes.length === 0) throw new ImportError("Empty chunk.", [], 400);
  if (input.bytes.length > limits.maxChunkBytes) throw new ImportError(`Chunk too large (max ${Math.round(limits.maxChunkBytes / 1024 / 1024)} MB per request).`, [], 413);

  const existing = await pool.query(`SELECT COALESCE(sum(octet_length(chunk_bytes)), 0)::bigint AS bytes FROM nl2sql.upload_chunks WHERE upload_id = $1`, [input.uploadId]);
  const soFar = Number(existing.rows[0].bytes);
  if (soFar + input.bytes.length > limits.maxChunkedUploadTotalBytes) {
    throw new ImportError(`This upload is too large in total (max ${Math.round(limits.maxChunkedUploadTotalBytes / 1024 / 1024)} MB across all files).`, [], 413);
  }

  await pool.query(
    `INSERT INTO nl2sql.upload_chunks (upload_id, session_id, file_index, file_name, chunk_index, total_chunks, chunk_bytes)
     VALUES ($1,$2,$3,$4,$5,$6,$7)
     ON CONFLICT (upload_id, file_index, chunk_index)
     DO UPDATE SET chunk_bytes = EXCLUDED.chunk_bytes, file_name = EXCLUDED.file_name, total_chunks = EXCLUDED.total_chunks`,
    [input.uploadId, input.sessionId, input.fileIndex, input.fileName.slice(0, 120), input.chunkIndex, input.totalChunks, input.bytes],
  );
}

/**
 * Reassembles every file of a completed chunked upload. Verifies every chunk actually arrived (not just that SOME
 * chunks did) and that each file's real total size is within its type's limit, before handing back full file text —
 * the same checks the single-shot route makes, just after reassembly instead of before.
 */
export async function reassembleFiles(pool: pg.Pool, uploadId: string, sessionId: string, limits: UploadLimits): Promise<UploadedFile[]> {
  const meta = await pool.query(
    `SELECT file_index, file_name, total_chunks, count(*)::int AS have, COALESCE(sum(octet_length(chunk_bytes)), 0)::bigint AS bytes
       FROM nl2sql.upload_chunks WHERE upload_id = $1 AND session_id = $2 GROUP BY file_index, file_name, total_chunks ORDER BY file_index`,
    [uploadId, sessionId],
  );
  if (meta.rows.length === 0) throw new ImportError("This upload was not found (it may have expired). Please upload again.", [], 404);

  for (const row of meta.rows) {
    if (row.have !== row.total_chunks) throw new ImportError(`Upload incomplete for "${row.file_name}" (${row.have}/${row.total_chunks} chunks received). Please upload again.`, [], 409);
    const isSql = String(row.file_name).toLowerCase().endsWith(".sql");
    const max = isSql ? limits.maxSqlBytes : limits.maxCsvBytes;
    if (Number(row.bytes) > max) throw new ImportError(`"${row.file_name}" is too large (max ${Math.round(max / 1024 / 1024)} MB for ${isSql ? ".sql" : ".csv"} files).`, [], 413);
  }

  const files: UploadedFile[] = [];
  for (const row of meta.rows) {
    const res = await pool.query(`SELECT string_agg(chunk_bytes, ''::bytea ORDER BY chunk_index) AS data FROM nl2sql.upload_chunks WHERE upload_id = $1 AND file_index = $2`, [uploadId, row.file_index]);
    const buf = res.rows[0].data as Buffer;
    files.push({ name: String(row.file_name), text: buf.toString("utf-8") });
  }
  return files;
}

export async function deleteChunks(pool: pg.Pool, uploadId: string): Promise<void> {
  await pool.query(`DELETE FROM nl2sql.upload_chunks WHERE upload_id = $1`, [uploadId]);
}

/** An upload the user never finalized (closed the tab, network failure) is purged after a couple of hours — mirrors purgeExpiredDatasets. */
export async function purgeStaleChunks(pool: pg.Pool, maxAgeHours = 2): Promise<number> {
  const res = await pool.query(`DELETE FROM nl2sql.upload_chunks WHERE created_at < now() - ($1 || ' hours')::interval`, [String(maxAgeHours)]);
  return res.rowCount ?? 0;
}
