import type { DbErrorCategory, ExecutionError } from "@/lib/types";

/** Map PostgreSQL SQLSTATE codes (and Node connection errors) to a category and a user-safe message. */
const SQLSTATE_CATEGORY: [RegExp, DbErrorCategory][] = [
  [/^42601$/, "syntax"],
  [/^42703$/, "undefined_column"],
  [/^42P01$/, "undefined_table"],
  [/^42883$/, "undefined_function"],
  [/^42804$|^42846$|^22P02$|^22007$|^22008$|^42725$/, "type_mismatch"],
  [/^42501$/, "permission"],
  [/^57014$/, "timeout"],
  [/^22/, "data_exception"],
  [/^42/, "syntax"],
  [/^(08|53|57P|28|3D)/, "connection"],
];

const USER_MESSAGES: Record<DbErrorCategory, string> = {
  syntax: "The generated query had a syntax problem.",
  undefined_column: "The generated query referenced a column that does not exist.",
  undefined_table: "The generated query referenced a table that does not exist.",
  undefined_function: "The generated query used a function or operator that is not available for those data types.",
  type_mismatch: "The generated query mixed incompatible data types.",
  permission: "The generated query tried to access something it is not permitted to read.",
  timeout: "The query took too long and was cancelled. Try a narrower question (for example a shorter time range).",
  data_exception: "The query hit invalid data (for example a division by zero or a bad date).",
  connection: "The database is temporarily unavailable. Please try again shortly.",
  unknown: "The database could not run the generated query.",
};

/** Scrub anything that could carry connection details (hosts, users, passwords, IPs). */
function scrub(message: string): string {
  return message
    .replace(/postgres(ql)?:\/\/\S+/gi, "[redacted-url]")
    .replace(/\b\d{1,3}(\.\d{1,3}){3}(:\d+)?\b/g, "[redacted-ip]")
    .replace(/password[^,;]*/gi, "[redacted]")
    .slice(0, 400);
}

export function classifyDbError(err: unknown): ExecutionError {
  const e = err as { code?: string; message?: string; hint?: string; position?: string };
  const code = typeof e?.code === "string" ? e.code : "UNKNOWN";
  let category: DbErrorCategory = "unknown";
  if (/^[0-9A-Z]{5}$/.test(code)) {
    for (const [re, cat] of SQLSTATE_CATEGORY) {
      if (re.test(code)) {
        category = cat;
        break;
      }
    }
  } else if (/^(ECONN|ENOTFOUND|ETIMEDOUT|EAI_AGAIN|EPIPE)/.test(code) || /timeout|connect/i.test(e?.message ?? "")) {
    category = "connection";
  }

  const rawMessage = e?.message ?? "Unknown database error";
  // Query-level errors (classes 22/42/57014) carry useful, non-sensitive messages for the correction agent.
  const detail = category === "connection" || category === "unknown" ? undefined : scrub(`${rawMessage}${e?.hint ? ` Hint: ${e.hint}` : ""}`);
  return { code, category, message: USER_MESSAGES[category], detail };
}
