import { ImportError, type UploadLimits } from "./limits";

/**
 * CSV → table plan. Pure functions: parse, sanitise names, infer conservative column types. Nothing touches the database
 * here; import-service.ts creates the tables with quoted, sanitised identifiers and loads the data with bound parameters.
 */

export type CsvColumnType = "integer" | "bigint" | "numeric" | "boolean" | "date" | "timestamp" | "timestamptz" | "text";

export interface CsvColumnPlan {
  name: string;
  original: string;
  type: CsvColumnType;
}

export interface CsvTablePlan {
  name: string;
  fileName: string;
  columns: CsvColumnPlan[];
  /** Cell values; empty cells are null. */
  rows: (string | null)[][];
}

export interface CsvImportPlan {
  tables: CsvTablePlan[];
  stats: { tables: number; columns: number; rows: number };
  warnings: string[];
}

// ───────────────────────── parsing ─────────────────────────
function detectDelimiter(firstLine: string): string {
  let best = ",";
  let bestCount = 0;
  for (const d of [",", ";", "\t", "|"]) {
    let inQuotes = false;
    let n = 0;
    for (const ch of firstLine) {
      if (ch === '"') inQuotes = !inQuotes;
      else if (ch === d && !inQuotes) n++;
    }
    if (n > bestCount) {
      best = d;
      bestCount = n;
    }
  }
  return best;
}

/** RFC 4180 parser (quoted fields, doubled quotes, CRLF/LF/CR, embedded newlines). Returns records with their start line. */
export function parseCsv(text: string): { records: string[][]; lines: number[]; delimiter: string } {
  const src = text.replace(/^﻿/, "");
  const delimiter = detectDelimiter(src.split(/\r\n|\n|\r/, 1)[0] ?? "");
  const records: string[][] = [];
  const lines: number[] = [];
  let field = "";
  let row: string[] = [];
  let inQuotes = false;
  let line = 1;
  let recordLine = 1;
  let hadContent = false;

  const endField = () => {
    row.push(field);
    field = "";
  };
  const endRecord = () => {
    endField();
    if (!(row.length === 1 && row[0] === "" && !hadContent)) {
      records.push(row);
      lines.push(recordLine);
    }
    row = [];
    hadContent = false;
  };

  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (inQuotes) {
      if (ch === '"') {
        if (src[i + 1] === '"') {
          field += '"';
          i++;
        } else inQuotes = false;
      } else {
        if (ch === "\n") line++;
        field += ch;
      }
      continue;
    }
    if (ch === '"' && field === "") {
      inQuotes = true;
      hadContent = true;
    } else if (ch === delimiter) {
      endField();
      hadContent = true;
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && src[i + 1] === "\n") i++;
      endRecord();
      line++;
      recordLine = line;
    } else {
      field += ch;
      hadContent = true;
    }
  }
  if (inQuotes) throw new ImportError("The CSV has an unterminated quoted field.");
  if (field !== "" || row.length > 0 || hadContent) endRecord();
  return { records, lines, delimiter };
}

// ───────────────────────── names ─────────────────────────
export function sanitizeName(raw: string, fallback: string, maxLen = 40): string {
  let n = raw
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
  if (!n) n = fallback;
  if (/^[0-9]/.test(n)) n = `c_${n}`;
  return n.slice(0, maxLen);
}

function dedupe(names: string[]): string[] {
  const seen = new Map<string, number>();
  return names.map((n) => {
    const count = (seen.get(n) ?? 0) + 1;
    seen.set(n, count);
    return count === 1 ? n : `${n}_${count}`;
  });
}

// ───────────────────────── type inference ─────────────────────────
const INT = /^-?(0|[1-9][0-9]*)$/;
const NUM = /^-?(0|[1-9][0-9]*)?\.?[0-9]+([eE][+-]?[0-9]+)?$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const TS = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(:\d{2}(\.\d{1,6})?)?(Z|[+-]\d{2}(:?\d{2})?)?$/;
const BOOL = new Set(["true", "false", "yes", "no"]);

function validDate(s: string): boolean {
  const [y, m, d] = s.slice(0, 10).split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}

/** Conservative: a column only gets a specific type if EVERY non-empty value fits; otherwise text. */
export function inferColumnType(values: (string | null)[]): CsvColumnType {
  const vals = values.filter((v): v is string => v !== null);
  if (vals.length === 0) return "text";
  if (vals.every((v) => BOOL.has(v.toLowerCase()))) return "boolean";
  if (vals.every((v) => INT.test(v) && v.replace("-", "").length <= 18)) return vals.every((v) => Math.abs(Number(v)) <= 2147483647) ? "integer" : "bigint";
  // leading-zero codes (zip codes, ids like 007) stay text — INT regex already excludes them; numeric must not start with 0 digits either
  if (vals.every((v) => NUM.test(v) && !/^-?0[0-9]/.test(v))) return "numeric";
  if (vals.every((v) => DATE.test(v) && validDate(v))) return "date";
  if (vals.every((v) => TS.test(v) && validDate(v))) return vals.some((v) => /(Z|[+-]\d{2}(:?\d{2})?)$/.test(v.slice(10))) ? "timestamptz" : "timestamp";
  return "text";
}

export function pgTypeFor(t: CsvColumnType): string {
  return { integer: "integer", bigint: "bigint", numeric: "numeric", boolean: "boolean", date: "date", timestamp: "timestamp", timestamptz: "timestamptz", text: "text" }[t];
}

// ───────────────────────── plan ─────────────────────────
export function planCsvImport(files: { name: string; text: string }[], limits: UploadLimits): CsvImportPlan {
  if (files.length === 0) throw new ImportError("No CSV files were provided.");
  if (files.length > limits.maxFiles) throw new ImportError(`Too many files (${files.length}; max ${limits.maxFiles}).`);
  const tables: CsvTablePlan[] = [];
  const warnings: string[] = [];
  const usedNames = new Set<string>();
  let totalRows = 0;
  let totalColumns = 0;

  for (const file of files) {
    if (Buffer.byteLength(file.text) > limits.maxCsvBytes) throw new ImportError(`"${file.name}" is too large (max ${Math.round(limits.maxCsvBytes / 1024 / 1024)} MB per CSV file).`);
    if (file.text.trim() === "") throw new ImportError(`"${file.name}" is empty.`);
    if (file.text.includes(String.fromCharCode(0))) throw new ImportError(`"${file.name}" contains binary data and is not a CSV text file.`);

    const { records, lines } = parseCsv(file.text);
    if (records.length === 0) throw new ImportError(`"${file.name}" is empty.`);
    const header = records[0];
    if (header.length < 1 || header.every((h) => h.trim() === "")) throw new ImportError(`"${file.name}" has no header row.`);
    if (header.length > limits.maxColumnsPerTable) throw new ImportError(`"${file.name}" has ${header.length} columns (max ${limits.maxColumnsPerTable}).`);

    const width = header.length;
    const bad: string[] = [];
    for (let r = 1; r < records.length; r++) {
      if (records[r].length !== width) {
        if (bad.length < 5) bad.push(`line ${lines[r]}: ${records[r].length} fields, expected ${width}`);
        else if (bad.length === 5) bad.push("…");
      }
    }
    if (bad.length) throw new ImportError(`"${file.name}" has rows whose number of fields does not match the header (${width} columns).`, bad);

    const dataRows = records.slice(1).map((r) => r.map((c) => (c.trim() === "" ? null : c)));
    totalRows += dataRows.length;
    if (totalRows > limits.maxRows) throw new ImportError(`Too many rows (max ${limits.maxRows.toLocaleString("en-US")} across all files).`);

    let base = sanitizeName(file.name.replace(/\.[^.]*$/, ""), "table");
    // names starting with pg_ are PostgreSQL system-catalog names (and refused by the query validator): keep them out of the schema
    if (/^pg_/.test(base)) base = `t_${base}`.slice(0, 40);
    let tname = base;
    for (let i = 2; usedNames.has(tname); i++) tname = `${base}_${i}`.slice(0, 44);
    usedNames.add(tname);
    base = tname;

    const names = dedupe(header.map((h, i) => sanitizeName(h, `column_${i + 1}`, 50)));
    const columns: CsvColumnPlan[] = names.map((name, i) => ({ name, original: header[i], type: inferColumnType(dataRows.map((r) => r[i])) }));
    if (dataRows.length === 0) warnings.push(`"${file.name}" has a header but no data rows; all its columns are text.`);
    if (names.some((n, i) => n !== header[i].trim())) warnings.push(`Column names in "${file.name}" were normalised to lower-case snake_case.`);
    totalColumns += columns.length;
    tables.push({ name: base, fileName: file.name, columns, rows: dataRows });
  }

  if (tables.length > limits.maxTables) throw new ImportError(`Too many tables (${tables.length}; max ${limits.maxTables}).`);
  if (totalColumns > limits.maxTotalColumns) throw new ImportError(`Too many columns (${totalColumns}; max ${limits.maxTotalColumns}).`);
  return { tables, stats: { tables: tables.length, columns: totalColumns, rows: totalRows }, warnings: [...new Set(warnings)] };
}
