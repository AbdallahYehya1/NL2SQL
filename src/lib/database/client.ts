import pg from "pg";
import { getConfig } from "@/lib/config";

/**
 * PostgreSQL connection pools. Server-side only.
 *
 *  - admin pool     : DATABASE_URL           → query history, metadata embeddings, feedback
 *  - execution pool : READONLY_DATABASE_URL  → LLM-generated SQL (login as the nl2sql_readonly role)
 *                     or, if unset, DATABASE_URL + `SET LOCAL ROLE nl2sql_readonly` inside a READ ONLY transaction
 *
 * Pools are cached on globalThis so Next.js dev hot-reloads and warm serverless invocations reuse them.
 */

const { types } = pg;

/** Return JSON-friendly values: bigint/numeric → number, timestamptz → ISO string, date stays 'YYYY-MM-DD'. */
const typeParsers = {
  getTypeParser: (oid: number, format?: "text" | "binary") => {
    if (oid === 20 || oid === 1700) return (v: string) => Number(v); // int8, numeric
    if (oid === 1082) return (v: string) => v; // date
    if (oid === 1184) return (v: string) => new Date(v).toISOString(); // timestamptz
    return types.getTypeParser(oid, format as "text");
  },
};

function isLocalHost(url: string): boolean {
  try {
    const host = new URL(url).hostname;
    return host === "localhost" || host === "127.0.0.1" || host === "::1" || host === "host.docker.internal";
  } catch {
    return false;
  }
}

export function poolConfigFor(connectionString: string, sslMode: "auto" | "true" | "false", max: number): pg.PoolConfig {
  // Strip sslmode so node-postgres does not override our explicit ssl setting.
  let cleaned = connectionString;
  try {
    const u = new URL(connectionString);
    u.searchParams.delete("sslmode");
    cleaned = u.toString();
  } catch {
    /* leave as is */
  }
  const useSsl = sslMode === "true" || (sslMode === "auto" && !isLocalHost(connectionString));
  return {
    connectionString: cleaned,
    ssl: useSsl ? { rejectUnauthorized: false } : undefined,
    max,
    idleTimeoutMillis: 10_000,
    connectionTimeoutMillis: 8_000,
    types: typeParsers as unknown as pg.PoolConfig["types"],
  };
}

interface PoolRegistry {
  admin?: pg.Pool;
  readonly?: pg.Pool;
}
const g = globalThis as unknown as { __nl2sqlPools?: PoolRegistry };
const pools: PoolRegistry = (g.__nl2sqlPools ??= {});

export class DatabaseNotConfiguredError extends Error {
  constructor(message = "DATABASE_URL is not configured.") {
    super(message);
    this.name = "DatabaseNotConfiguredError";
  }
}

export function isDatabaseConfigured(): boolean {
  return Boolean(getConfig().databaseUrl);
}

export function getAdminPool(): pg.Pool {
  const cfg = getConfig();
  if (!cfg.databaseUrl) throw new DatabaseNotConfiguredError();
  return (pools.admin ??= new pg.Pool(poolConfigFor(cfg.databaseUrl, cfg.databaseSsl, 3)));
}

export interface ExecutionPool {
  pool: pg.Pool;
  /** true → connection is already the read-only role; false → must SET LOCAL ROLE per transaction. */
  loggedInAsReadonly: boolean;
}

export function getExecutionPool(): ExecutionPool {
  const cfg = getConfig();
  if (cfg.readonlyDatabaseUrl) {
    return { pool: (pools.readonly ??= new pg.Pool(poolConfigFor(cfg.readonlyDatabaseUrl, cfg.databaseSsl, 3))), loggedInAsReadonly: true };
  }
  return { pool: getAdminPool(), loggedInAsReadonly: false };
}

export async function closePools(): Promise<void> {
  const all = [pools.admin, pools.readonly].filter((p): p is pg.Pool => !!p);
  pools.admin = undefined;
  pools.readonly = undefined;
  await Promise.all(all.map((p) => p.end().catch(() => undefined)));
}
