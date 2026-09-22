/** Client-side view of the dataset API (mirrors src/lib/datasets/store.ts; kept separate so client bundles never import server code). */

export interface DatasetDto {
  id: string;
  name: string;
  sourceType: "builtin" | "sql" | "csv";
  status: "processing" | "ready" | "failed" | "deleted";
  tableCount: number;
  columnCount: number;
  rowCount: number;
  relationshipCount: number;
  createdAt: string;
  isBuiltin: boolean;
  error?: string;
  embeddingStatus?: string;
  descriptionsGeneratedBy?: string;
  pendingRelationships: number;
}

export interface SuggestedRelationship {
  fromTable: string;
  fromColumn: string;
  toTable: string;
  toColumn: string;
  evidence: string;
}

export interface DatasetDetailsDto {
  dataset: DatasetDto;
  tables: {
    name: string;
    description: string;
    descriptionSource?: string;
    rowCount?: number;
    primaryKey: string[];
    columns: { name: string; type: string; nullable?: boolean; primaryKey: boolean; references?: string; description: string; descriptionSource?: string; sampleValues?: string[] }[];
  }[];
  relationships: { fromTable: string; fromColumn: string; toTable: string; toColumn: string }[];
  suggestedRelationships: SuggestedRelationship[];
  suggestedQuestions: string[];
}

export interface UploadLimitsDto {
  maxRequestMb: number;
  maxCsvMb: number;
  maxFiles: number;
  maxTables: number;
  maxColumnsPerTable: number;
  maxRows: number;
  maxDatasetsPerSession: number;
  ttlHours: number;
}

export const ACTIVE_DATASET_KEY = "nl2sql_active_dataset";

export const fmt = new Intl.NumberFormat("en-US");

export function summarise(d: DatasetDto): string {
  return `${d.tableCount} table${d.tableCount === 1 ? "" : "s"} · ${fmt.format(d.rowCount)} rows`;
}

export const SOURCE_LABEL: Record<DatasetDto["sourceType"], string> = { builtin: "Built-in demo", sql: "SQL upload", csv: "CSV upload" };
