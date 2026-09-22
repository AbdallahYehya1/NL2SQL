import { createHash } from "node:crypto";
import type { AIProvider, GenerateResult, StructuredResult } from "@/lib/ai/provider";
import { contentTokens } from "@/lib/nl2sql/text";

/**
 * Test double for AIProvider.embed(): deterministic 768-d bag-of-words hashing embeddings (L2-normalised).
 * It is NOT semantic — it only lets the tests exercise the pgvector plumbing (sync, cosine search, hybrid blend).
 */
export function hashEmbedding(text: string, dims = 768): number[] {
  const v = new Array<number>(dims).fill(0);
  for (const tok of contentTokens(text)) {
    const h = createHash("sha256").update(tok).digest();
    v[h.readUInt16BE(0) % dims] += 1;
    v[h.readUInt16BE(2) % dims] += 0.5;
  }
  const norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0)) || 1;
  return v.map((x) => x / norm);
}

export class HashEmbedder implements AIProvider {
  readonly name = "hash-embedder";
  readonly model = "none";
  readonly embeddingModel = "hash-768";
  embedCalls = 0;
  async generate(): Promise<GenerateResult> {
    throw new Error("not a chat provider");
  }
  async generateStructured<T>(): Promise<StructuredResult<T>> {
    throw new Error("not a chat provider");
  }
  async embed(texts: string[]): Promise<number[][]> {
    this.embedCalls += texts.length;
    return texts.map((t) => hashEmbedding(t));
  }
  canEmbed() {
    return true;
  }
}
