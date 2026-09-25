/**
 * Upload limits. Chosen for a demo/portfolio deployment on Vercel + Supabase free tiers — NOT for migrating production
 * databases. Vercel serverless functions reject request bodies larger than 4.5 MB, which is the binding constraint on
 * any ONE request — but not on a file's total size: files above maxRequestBytes are sent in chunks (see
 * chunked-upload.ts), each comfortably under that per-request ceiling, and reassembled server-side before import.
 * maxCsvBytes/maxSqlBytes/maxRows are therefore the real per-dataset ceilings, not maxRequestBytes.
 * Several limits can be tuned with environment variables (DATASET_MAX_ROWS, DATASET_TTL_HOURS, DATASET_MAX_CSV_MB, DATASET_MAX_SQL_MB).
 */

export interface UploadLimits {
  /** A single request's body. Below this, the client uses the simple one-shot upload; at/above it, chunked upload. */
  maxRequestBytes: number;
  /** One chunk's body in the chunked-upload path — comfortably under Vercel's 4.5 MB serverless request-body limit. */
  maxChunkBytes: number;
  /** Every file in one chunked upload combined — bounds how much chunk data can sit in the staging table at once. */
  maxChunkedUploadTotalBytes: number;
  maxSqlBytes: number;
  maxCsvBytes: number;
  maxFiles: number;
  maxTables: number;
  maxColumnsPerTable: number;
  maxTotalColumns: number;
  /** Total rows across all tables (INSERT tuples / CSV data rows). */
  maxRows: number;
  maxSqlStatements: number;
  maxNameLength: number;
  /** Datasets one browser session may hold at the same time. */
  maxDatasetsPerSession: number;
  /** Upload attempts per client per hour. */
  maxUploadsPerHour: number;
  /** Uploaded datasets are deleted after this many hours (storage hygiene + privacy). */
  ttlHours: number;
  /** Hard time budget for the import transaction. */
  importTimeoutMs: number;
  /** Distinct sample values kept per column in the metadata. */
  sampleValuesPerColumn: number;
  /** Columns with at most this many distinct values are treated as categorical (all values listed). */
  categoricalMaxDistinct: number;
  /** Above this many metadata items only table-level embeddings are created. */
  maxEmbeddingItems: number;
}

const int = (v: string | undefined, def: number) => {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : def;
};

export function getUploadLimits(env: Record<string, string | undefined> = process.env): UploadLimits {
  const maxRows = int(env.DATASET_MAX_ROWS, 300_000);
  return {
    maxRequestBytes: 4 * 1024 * 1024,
    maxChunkBytes: 3.5 * 1024 * 1024,
    maxChunkedUploadTotalBytes: 80 * 1024 * 1024,
    maxSqlBytes: int(env.DATASET_MAX_SQL_MB, 40) * 1024 * 1024,
    maxCsvBytes: int(env.DATASET_MAX_CSV_MB, 40) * 1024 * 1024,
    maxFiles: 10,
    maxTables: 30,
    maxColumnsPerTable: 60,
    maxTotalColumns: 400,
    maxRows,
    // A dump with one INSERT per row makes every row a statement, so this must scale with maxRows (plus room for the DDL) or it silently becomes the real row ceiling.
    maxSqlStatements: maxRows + 10_000,
    maxNameLength: 60,
    maxDatasetsPerSession: 5,
    maxUploadsPerHour: 6,
    ttlHours: int(env.DATASET_TTL_HOURS, 72),
    importTimeoutMs: 45_000,
    sampleValuesPerColumn: 5,
    categoricalMaxDistinct: 12,
    maxEmbeddingItems: 400,
  };
}

/** A user-facing import problem. `details` lists individual issues (bounded). */
export class ImportError extends Error {
  constructor(
    message: string,
    readonly details: string[] = [],
    /** HTTP status the API should answer with (422 = the upload itself is unacceptable, 429 = rate limited). */
    readonly httpStatus: number = 422,
  ) {
    super(message);
    this.name = "ImportError";
  }
}

export const UNSUPPORTED_SQL_MESSAGE = "This SQL file contains unsupported statements.";
