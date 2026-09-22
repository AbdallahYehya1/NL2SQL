import { randomUUID } from "node:crypto";
import { cookies, headers } from "next/headers";
import { getConfig } from "@/lib/config";
import { hashClient } from "@/lib/history/store";
import type { ErrorCode } from "@/lib/types";

const SID_COOKIE = "nl2sql_sid";
const SID_PATTERN = /^[0-9a-f-]{36}$/;

/** Anonymous per-browser session id (httpOnly cookie). Scopes the history list; not an authentication mechanism. */
export async function getSessionId(create: boolean): Promise<string | undefined> {
  const jar = await cookies();
  const existing = jar.get(SID_COOKIE)?.value;
  if (existing && SID_PATTERN.test(existing)) return existing;
  if (!create) return undefined;
  const sid = randomUUID();
  jar.set(SID_COOKIE, sid, { httpOnly: true, sameSite: "lax", secure: process.env.NODE_ENV === "production", path: "/", maxAge: 60 * 60 * 24 * 365 });
  return sid;
}

export async function getClientHash(): Promise<string> {
  const h = await headers();
  const ip = h.get("x-forwarded-for")?.split(",")[0]?.trim() || h.get("x-real-ip") || "unknown";
  return hashClient(ip, getConfig().rateLimitSalt);
}

export function httpStatusFor(code: ErrorCode | undefined): number {
  switch (code) {
    case undefined:
      return 200;
    case "EMPTY_QUESTION":
    case "QUESTION_TOO_LONG":
      return 400;
    case "DATASET_NOT_FOUND":
      return 404;
    case "DATASET_NOT_READY":
      return 409;
    case "RATE_LIMITED":
    case "PROVIDER_RATE_LIMIT":
      return 429;
    case "PROVIDER_NOT_CONFIGURED":
    case "DATABASE_UNAVAILABLE":
    case "PROVIDER_UNAVAILABLE":
      return 503;
    case "PROVIDER_AUTH":
    case "PROVIDER_BAD_OUTPUT":
      return 502;
    case "SQL_REJECTED":
    case "SQL_EXECUTION_FAILED":
    case "SQL_GENERATION_FAILED":
      return 422;
    default:
      return 500;
  }
}
