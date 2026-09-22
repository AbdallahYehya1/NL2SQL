import { NextResponse } from "next/server";
import { getConfig } from "@/lib/config";
import { getAdminPool, isDatabaseConfigured } from "@/lib/database/client";
import { countEmbeddings } from "@/lib/metadata/embeddings";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Setup diagnostics for the UI. Reports only booleans / counts — never secrets or connection details. */
export async function GET() {
  const cfg = getConfig();
  const ai = { provider: cfg.ai.provider, model: cfg.ai.model ?? null, configured: Boolean(cfg.ai.model && (cfg.ai.apiKey || cfg.ai.provider === "ollama" || cfg.ai.provider === "custom")) };
  let database = { configured: isDatabaseConfigured(), reachable: false };
  let embeddings = { configured: Boolean(cfg.embedding.model), stored: 0 };
  if (database.configured) {
    try {
      const pool = getAdminPool();
      await pool.query("SELECT 1");
      database = { ...database, reachable: true };
      embeddings = { ...embeddings, stored: await countEmbeddings(pool) };
    } catch {
      /* reported as unreachable */
    }
  }
  const retrieval = embeddings.configured && embeddings.stored > 0 ? "hybrid (lexical + vector)" : "lexical";
  return NextResponse.json({ ok: ai.configured && database.reachable, ai, database, embeddings, retrieval });
}
