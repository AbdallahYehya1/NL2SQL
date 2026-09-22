import { containsPhrase, containsPhraseLoose, contentTokens, stemmedTokens } from "@/lib/nl2sql/text";
import type { MetadataItem } from "@/lib/types";

/**
 * Lexical (keyword / exact-match) retrieval over registry metadata: a small BM25-flavoured scorer with
 * IDF weighting, extra weight for name/synonym hits and a bonus for multi-word phrase matches
 * ("average order value", "low stock"). Runs in-process, needs no API — this is the always-available
 * fallback that the vector search complements.
 */

interface IndexedItem {
  item: MetadataItem;
  nameTokens: Set<string>;
  textTokens: Map<string, number>;
  phrases: { tokens: string[]; contentTokens: string[]; idfSum: number }[];
}

/**
 * Scores are divided by max(best score of that kind, FLOOR). The floor stops a single weak, common-word hit
 * from being scaled up to 1.0 when nothing else matched.
 */
const NORMALISATION_FLOOR = 6;

/** Minimum score for a table whose own name appears in the question. */
const EXPLICIT_TABLE_MENTION_SCORE = 0.75;

export interface QueryTerm {
  stem: string;
  weight: number;
}

export interface LexicalQuery {
  terms: QueryTerm[];
  /** Full stemmed token sequence (stop words kept) for phrase matching. */
  sequence: string[];
}

export class LexicalIndex {
  private items: IndexedItem[] = [];
  private idf = new Map<string, number>();
  readonly vocabulary = new Set<string>();

  constructor(items: MetadataItem[]) {
    const df = new Map<string, number>();
    for (const item of items) {
      // Single-word names/synonyms count as name tokens; so does a table/column's own identifier (order_items → order, item).
      // Words that only occur inside multi-word synonyms or metric names ("month over month", "net_revenue") must not
      // match on their own — those are matched as phrases below.
      const nameTokens = new Set(
        item.names.filter((n, i) => contentTokens(n).length === 1 || (i < 2 && item.kind !== "metric")).flatMap(contentTokens),
      );
      const textTokens = new Map<string, number>();
      for (const t of contentTokens(item.text)) textTokens.set(t, (textTokens.get(t) ?? 0) + 1);
      const all = new Set([...nameTokens, ...textTokens.keys()]);
      for (const t of all) df.set(t, (df.get(t) ?? 0) + 1);
      this.items.push({ item, nameTokens, textTokens, phrases: [] });
    }
    const n = items.length;
    for (const [t, d] of df) this.idf.set(t, Math.log(1 + n / d));
    for (const ix of this.items) {
      ix.phrases = ix.item.names
        .map((name) => ({ tokens: stemmedTokens(name), content: contentTokens(name) }))
        .filter((p) => new Set(p.content).size >= 2)
        .map(({ tokens, content }) => ({ tokens, contentTokens: content, idfSum: content.reduce((s, t) => s + (this.idf.get(t) ?? 0.5), 0) }));
      for (const t of ix.nameTokens) this.vocabulary.add(t);
    }
  }

  /** Query terms from free text. */
  static buildQuery(question: string, extraTerms: string[] = []): LexicalQuery {
    const terms = new Map<string, number>();
    for (const t of contentTokens(question)) terms.set(t, Math.max(terms.get(t) ?? 0, 1));
    for (const t of extraTerms.flatMap(contentTokens)) terms.set(t, Math.max(terms.get(t) ?? 0, 0.6));
    return { terms: [...terms].map(([stem, weight]) => ({ stem, weight })), sequence: stemmedTokens(question) };
  }

  /** How many query terms are known domain vocabulary (table/column/synonym words). */
  domainHits(query: LexicalQuery): string[] {
    return query.terms.filter((t) => this.vocabulary.has(t.stem) && (this.idf.get(t.stem) ?? 0) > 0).map((t) => t.stem);
  }

  /** Scores per item, normalised to 0..1 within each item kind (see NORMALISATION_FLOOR). */
  search(query: LexicalQuery): Map<string, number> {
    const raw = new Map<string, number>();
    for (const ix of this.items) {
      let nameScore = 0;
      let textScore = 0;
      for (const { stem, weight } of query.terms) {
        const idf = this.idf.get(stem) ?? 0;
        if (!idf) continue;
        if (ix.nameTokens.has(stem)) nameScore += weight * idf;
        const tf = ix.textTokens.get(stem);
        if (tf) textScore += weight * idf * (1 - Math.exp(-tf)) * 0.35;
      }
      let phraseScore = 0;
      for (const p of ix.phrases) {
        if (containsPhrase(query.sequence, p.tokens)) phraseScore += p.idfSum * 1.5;
        else if (containsPhraseLoose(query.sequence, p.contentTokens)) phraseScore += p.idfSum * 1.0;
      }
      const score = 2 * nameScore + textScore + phraseScore;
      if (score > 0) raw.set(ix.item.id, score);
    }
    // normalise per kind so tables, columns and metrics are comparable
    const maxByKind = new Map<string, number>();
    for (const ix of this.items) {
      const s = raw.get(ix.item.id);
      if (s) maxByKind.set(ix.item.kind, Math.max(maxByKind.get(ix.item.kind) ?? 0, s));
    }
    const out = new Map<string, number>();
    for (const ix of this.items) {
      let score = (raw.get(ix.item.id) ?? 0) / Math.max(maxByKind.get(ix.item.kind) ?? 1, NORMALISATION_FLOOR);
      // A table that is named outright in the question ("employees", "product categories") is always relevant,
      // even when another table matches more of the words.
      if (ix.item.kind === "table" && containsPhrase(query.sequence, stemmedTokens(ix.item.names[0]))) score = Math.max(score, EXPLICIT_TABLE_MENTION_SCORE);
      if (score > 0) out.set(ix.item.id, Math.min(1, score));
    }
    return out;
  }
}
