/**
 * Static SQL security policy. Pure data — enforced deterministically by src/lib/database/validator.ts,
 * never by prompting the model.
 */

/**
 * Write/DDL/administrative keywords that must never appear as bare words (first, cheap layer of defence).
 * The AST check below is the authoritative layer; this gives clear error messages and defence in depth.
 */
export const BLOCKED_KEYWORDS = [
  "INSERT", "UPDATE", "DELETE", "MERGE", "DROP", "ALTER", "TRUNCATE", "CREATE", "GRANT", "REVOKE",
  "COPY", "CALL", "EXECUTE", "VACUUM", "REINDEX", "REFRESH", "LISTEN", "NOTIFY", "DISCARD",
] as const;

/**
 * Functions the generated SQL may call. An allow-list (not a deny-list): anything not listed —
 * pg_sleep, set_config, pg_read_file, dblink, lo_*, current_setting, query_to_xml, ... — is rejected.
 */
export const ALLOWED_FUNCTIONS: ReadonlySet<string> = new Set([
  // aggregates
  "count", "sum", "avg", "min", "max", "stddev", "stddev_pop", "stddev_samp", "variance", "var_pop", "var_samp",
  "string_agg", "array_agg", "bool_and", "bool_or", "every", "percentile_cont", "percentile_disc", "mode",
  "corr", "covar_pop", "covar_samp", "regr_slope", "regr_intercept", "json_agg", "jsonb_agg",
  // window
  "row_number", "rank", "dense_rank", "percent_rank", "cume_dist", "ntile", "lag", "lead", "first_value", "last_value", "nth_value",
  // math
  "abs", "round", "ceil", "ceiling", "floor", "trunc", "sqrt", "power", "pow", "exp", "ln", "log", "log10", "mod", "sign", "div", "width_bucket",
  // text
  "lower", "upper", "initcap", "length", "char_length", "character_length", "substr", "substring", "left", "right",
  "trim", "ltrim", "rtrim", "btrim", "replace", "concat", "concat_ws", "position", "strpos", "split_part", "starts_with",
  "lpad", "rpad", "reverse", "repeat", "overlay", "to_char", "to_number", "to_date", "to_timestamp", "regexp_replace", "format",
  // date / time
  "now", "date_trunc", "date_part", "extract", "age", "date", "make_date", "make_interval", "make_timestamp", "make_timestamptz",
  "timezone", "date_bin", "justify_days", "justify_hours", "justify_interval", "isfinite", "clock_timestamp", "statement_timestamp", "transaction_timestamp", "timeofday",
  // arrays / series
  "generate_series", "array_length", "cardinality", "unnest", "array_to_string", "array_position", "array_remove", "array_cat", "array_append",
  // misc
  "nullif", "coalesce", "greatest", "least", "to_json", "to_jsonb", "row_to_json", "json_build_object", "jsonb_build_object",
]);

/** Only the demo schema (or unqualified names, resolved by search_path) may be referenced. */
export const ALLOWED_SCHEMA = "shop";

/** SQLValueFunction ops that expose session identity. */
export const FORBIDDEN_SQL_VALUE_FUNCTIONS = new Set([
  "SVFOP_CURRENT_USER", "SVFOP_USER", "SVFOP_SESSION_USER", "SVFOP_CURRENT_ROLE", "SVFOP_CURRENT_CATALOG", "SVFOP_CURRENT_SCHEMA",
]);

export const LIMITS = {
  maxSqlLength: 4000,
  maxTables: 15,
  maxCtes: 8,
  maxAstNodes: 6000,
} as const;
