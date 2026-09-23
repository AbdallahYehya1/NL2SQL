/**
 * Shared formatting for the result/analytics UI. Kept separate from `lib/utils.ts` (table-cell formatting, which must
 * stay full-precision) because KPIs and chart axes intentionally use compact/rounded forms — see docs comments below.
 */

const fullNumber = new Intl.NumberFormat("en-US", { maximumFractionDigits: 2 });
const compactNumber = new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 2 });

/** Full precision with thousands separators — used in tables and anywhere exactness matters. */
export function formatNumberFull(n: number): string {
  if (!Number.isFinite(n)) return "—";
  return fullNumber.format(n);
}

/** Compact form (1.23M) for space-constrained displays: KPI headlines, chart axis ticks. Never used in the table. */
export function formatNumberCompact(n: number): string {
  if (!Number.isFinite(n)) return "—";
  if (Math.abs(n) < 1000) return fullNumber.format(n);
  return compactNumber.format(n);
}

/** True for `YYYY-MM-DD` or `YYYY-MM` style strings (not arbitrary date-ish text). */
export function isDateLike(v: unknown): v is string {
  return typeof v === "string" && /^\d{4}-\d{2}(-\d{2})?(T\d{2}:\d{2}(:\d{2}(\.\d+)?)?Z?)?$/.test(v);
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** `2025-03-01` → `Mar 2025`; `2025-03` → `Mar 2025`; `2025-03-14` → `Mar 14`; falls back to the raw string. */
export function formatDateLabel(v: unknown): string {
  const s = String(v);
  const m = s.match(/^(\d{4})-(\d{2})(?:-(\d{2}))?/);
  if (!m) return s.length > 14 ? `${s.slice(0, 13)}…` : s;
  const [, year, month, day] = m;
  const mi = Number(month) - 1;
  const label = MONTHS[mi] ?? month;
  if (!day) return `${label} ${year}`;
  return `${label} ${Number(day)}`;
}

/** Non-date label, truncated for axis/legend display. Full value stays available in the tooltip/table. */
export function truncateLabel(v: unknown, max = 16): string {
  const s = String(v ?? "");
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

function titleCaseWord(w: string): string {
  return w.length ? w[0].toUpperCase() + w.slice(1) : w;
}

/** `total_customers` → `Total Customers`. Reuses the table's underscore-splitting convention. */
export function titleCase(name: string): string {
  return name
    .replace(/_/g, " ")
    .split(" ")
    .filter(Boolean)
    .map(titleCaseWord)
    .join(" ");
}

const LEADING_QUESTION = /^\s*(?:please\s+|can you\s+|could you\s+)?(?:what (?:is|are|was|were)|what's|which|how many|how much|who|list|show( me)?|give me)\s+/i;
const TOP_N = /^\s*(top|bottom)\s+(\d+)\s+/i;
const TRAILING_TIME_QUALIFIER = /\s+(?:for|over|in|during)\s+the\s+last\s+\d+\s+\w+\s*$|\s+(?:for|over|in|during)\s+(?:this|last)\s+(?:year|month|week|quarter)\s*$/i;
// Left over after cleanup, these signal the phrase isn't a clean noun phrase yet — better to trust the schema-derived fallback.
const STOPWORDS = new Set(["the", "a", "an", "is", "are", "was", "were", "of", "that", "this", "most", "least", "highest", "lowest", "made", "had", "has", "have", "with", "by", "each"]);

/**
 * Best-effort chart title from the question text, e.g. "What were our monthly sales?" → "Monthly Sales".
 * Falls back to `fallback` (a schema-derived title) whenever the question doesn't clearly reduce to a short noun
 * phrase — this function only ever *shortens/cleans*, it never invents wording that isn't in the question.
 */
export function chartTitleFromQuestion(question: string, fallback: string): string {
  let q = question.trim().replace(/[?.!]+$/, "");
  const topMatch = q.match(TOP_N);
  let prefix = "";
  if (topMatch) {
    prefix = `${titleCaseWord(topMatch[1])} ${topMatch[2]} `;
    q = q.slice(topMatch[0].length);
  }
  q = q.replace(LEADING_QUESTION, "");
  q = q.replace(TRAILING_TIME_QUALIFIER, "");
  q = q.replace(/^(our|the|my)\s+/i, "");
  q = q.replace(/\bdid we\b|\bdo we\b|\bwe\b/gi, "").replace(/\s+/g, " ").trim();
  q = q.replace(/\bgenerated?\b/gi, "").replace(/\s+/g, " ").trim();
  // "products by revenue" / "revenue by product" style — keep short, clean results only, otherwise trust the fallback more
  const words = q.split(" ").filter(Boolean);
  const hasLeftoverStopword = words.some((w) => STOPWORDS.has(w.toLowerCase()));
  if (!q || words.length === 0 || words.length > 6 || hasLeftoverStopword) return fallback;
  return prefix + words.map(titleCaseWord).join(" ");
}

/** Deterministic "{Value} by {Label}" title from the actual result schema — always safe, never exposes raw identifiers. */
export function chartTitleFromColumns(labelKey: string, valueKeys: string[]): string {
  const values = valueKeys.map(titleCase).join(" & ");
  return `${values} by ${titleCase(labelKey)}`;
}

const CURRENCY_LAST_WORD = new Set(["revenue", "price", "cost", "amount", "spend", "value", "sales", "salary", "income", "profit"]);
const NON_CURRENCY_LAST_WORD = new Set(["count", "number", "quantity", "units", "rate", "percent", "percentage", "customers", "orders", "products", "reviews", "users", "items", "id", "total", "totals"]);

/**
 * Does this column name look like a currency amount worth a $ prefix? A naming heuristic only — the number itself is
 * never altered. Snake_case naming convention puts the measured quantity *last* ("average_order_value" is a value,
 * "total_customers" is a count of customers) — checking only the last word avoids false positives from a modifier
 * word ("order" in "order_value" isn't the measure) while still catching the actual unit. Ambiguous names (last word
 * matches neither list) default to false — a wrong $ is more misleading than a missing one.
 */
export function looksLikeCurrency(columnName: string): boolean {
  const words = columnName.toLowerCase().split("_").filter(Boolean);
  const last = words[words.length - 1];
  if (!last) return false;
  if (NON_CURRENCY_LAST_WORD.has(last)) return false;
  return CURRENCY_LAST_WORD.has(last);
}

const RAW_KEY_VALUE = /^([a-z][a-z0-9]*(?:_[a-z0-9]+)+)\s*:\s*(.+)$/;

/**
 * Some model-written summaries echo a raw `column_name: value` pair instead of prose (e.g. "total_customers: 1800").
 * Humanize just the identifier part for display — the value and any real prose are left untouched.
 */
export function humanizeKeyPoint(text: string): string {
  const m = text.match(RAW_KEY_VALUE);
  return m ? `${titleCase(m[1])}: ${m[2]}` : text;
}
