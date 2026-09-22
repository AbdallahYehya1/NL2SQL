import type pg from "pg";
import type { AIProvider } from "@/lib/ai/provider";
import { getBuiltinContext, type DatasetContext } from "@/lib/datasets/context";
import { LexicalIndex } from "@/lib/metadata/lexical";
import { vectorSearch } from "@/lib/metadata/embeddings";
import type { QuestionIntent, RetrievedItem } from "@/lib/types";

/**
 * Stage 3 — metadata retrieval: hybrid search over ONE dataset's metadata registry.
 *   lexical (keywords / synonyms / phrases)  +  vector (pgvector cosine similarity, when available)
 * Scores are normalised to 0..1 and blended. If embeddings are missing or the embedding API fails, retrieval
 * silently degrades to lexical only and reports why in the trace. Vector search is always filtered by dataset id,
 * so a question about dataset A can never retrieve metadata of dataset B.
 */

/** The lexical index of a dataset (built lazily and cached on its context). Defaults to the built-in demo. */
export function getLexicalIndex(dataset: DatasetContext = getBuiltinContext()): LexicalIndex {
  return dataset.lexical;
}

export interface RetrievalOptions {
  /** Dataset to search. Defaults to the built-in demo dataset. */
  dataset?: DatasetContext;
  intent?: QuestionIntent;
  /** Enables vector search when both are provided. */
  vector?: { provider: AIProvider; pool: pg.Pool };
  vectorK?: number;
  lexicalWeight?: number;
}

export interface RetrievalResult {
  method: "hybrid" | "lexical";
  vectorUnavailableReason?: string;
  items: RetrievedItem[];
}

export async function retrieveMetadata(question: string, options: RetrievalOptions = {}): Promise<RetrievalResult> {
  const dataset = options.dataset ?? getBuiltinContext();
  const itemById = new Map(dataset.index.items.map((i) => [i.id, i]));
  const extra = [...(options.intent?.concepts ?? []), ...(options.intent?.searchTerms ?? [])];
  const lexical = getLexicalIndex(dataset).search(LexicalIndex.buildQuery(question, extra));

  let vectorScores = new Map<string, number>();
  let method: RetrievalResult["method"] = "lexical";
  let reason: string | undefined;

  if (options.vector) {
    const { provider, pool } = options.vector;
    if (!provider.canEmbed()) {
      reason = "EMBEDDING_MODEL is not configured";
    } else {
      try {
        const [embedding] = await provider.embed([`${question} ${extra.join(" ")}`.trim()]);
        const hits = await vectorSearch(pool, embedding, options.vectorK ?? 40, provider.embeddingModel, dataset.id);
        if (hits.length === 0) reason = dataset.sourceType === "builtin" ? "no embeddings stored — run `npm run metadata:embed`" : "no embeddings stored for this dataset";
        else {
          vectorScores = normaliseSimilarities(hits);
          method = "hybrid";
        }
      } catch (err) {
        reason = `vector search failed: ${(err as Error).message.slice(0, 160)}`;
      }
    }
  } else {
    reason = "vector search not enabled";
  }

  const wLex = method === "hybrid" ? (options.lexicalWeight ?? 0.55) : 1;
  const ids = new Set([...lexical.keys(), ...vectorScores.keys()]);
  const items: RetrievedItem[] = [];
  for (const id of ids) {
    const meta = itemById.get(id);
    if (!meta) continue;
    const lex = lexical.get(id) ?? 0;
    const vec = vectorScores.get(id);
    const score = method === "hybrid" ? wLex * lex + (1 - wLex) * (vec ?? 0) : lex;
    if (score <= 0) continue;
    items.push({ id, kind: meta.kind, table: meta.table, column: meta.column, metric: meta.metric, score, lexicalScore: lex, vectorScore: vec });
  }
  items.sort((a, b) => b.score - a.score);
  return { method, vectorUnavailableReason: method === "lexical" ? reason : undefined, items };
}

/** Min-max normalise similarities of the returned top-K, so the best hit is 1 and the K-th is ~0. */
function normaliseSimilarities(hits: { itemId: string; similarity: number }[]): Map<string, number> {
  const max = Math.max(...hits.map((h) => h.similarity));
  const min = Math.min(...hits.map((h) => h.similarity));
  const span = max - min || 1;
  return new Map(hits.map((h) => [h.itemId, (h.similarity - min) / span]));
}
