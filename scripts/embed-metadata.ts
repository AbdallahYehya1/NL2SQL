/**
 * Embed the metadata registry (tables, columns, metrics) and store the vectors in nl2sql.metadata_embeddings.
 *   npm run metadata:embed
 * Requires DATABASE_URL and EMBEDDING_MODEL (+ AI_API_KEY / EMBEDDING_API_KEY). Re-run after editing the registry;
 * unchanged items are skipped.
 */
import { config as loadEnv } from "dotenv";
import { createProvider } from "../src/lib/ai/provider";
import { closePools, getAdminPool } from "../src/lib/database/client";
import { syncMetadataEmbeddings } from "../src/lib/metadata/embeddings";

loadEnv({ path: ".env.local" });
loadEnv({ path: ".env" });

async function main() {
  if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is not set.");
  const provider = createProvider();
  if (!provider.canEmbed()) throw new Error("EMBEDDING_MODEL is not configured — vector search stays disabled (lexical retrieval is used).");
  console.log(`Embedding registry metadata with ${provider.embeddingModel} …`);
  try {
    const result = await syncMetadataEmbeddings(getAdminPool(), provider);
    console.log(result);
  } finally {
    await closePools();
  }
}

main().catch((err) => {
  console.error(err.message ?? err);
  process.exit(1);
});
