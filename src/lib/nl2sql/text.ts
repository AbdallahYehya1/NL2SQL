/** Tiny text utilities shared by the analyzer and the lexical retriever (no external NLP dependency). */

export const STOPWORDS = new Set([
  "a", "an", "the", "of", "in", "on", "for", "to", "by", "per", "with", "and", "or", "is", "are", "was", "were", "be", "been",
  "do", "does", "did", "have", "has", "had", "what", "which", "who", "whom", "whose", "how", "when", "where", "why", "many", "much",
  "me", "my", "our", "we", "us", "you", "your", "it", "its", "this", "that", "these", "those", "there", "their", "them", "than", "then",
  "show", "list", "give", "tell", "get", "find", "display", "please", "can", "could", "would", "should", "will", "all", "each", "every",
  "any", "some", "from", "at", "as", "over", "into", "about", "also", "just", "only", "top", "last", "past", "previous", "current",
  "i", "im", "ive", "s", "not", "no", "yes", "if", "so", "up", "out", "more", "most", "less", "least", "between",
]);

/**
 * Very small suffix stemmer: enough to match inflections (orders → order, categories → category, ordered → order,
 * shipping → ship). It is applied identically to the index and to the question, so it only has to be consistent.
 */
export function stem(word: string): string {
  let w = word.toLowerCase();
  if (w.length <= 3) return w;
  if (w.endsWith("ies") && w.length > 4) w = `${w.slice(0, -3)}y`;
  else if (w.endsWith("sses")) w = w.slice(0, -2);
  else if (w.endsWith("ss") || w.endsWith("us") || w.endsWith("is")) return w;
  else if (w.endsWith("s")) w = w.slice(0, -1);
  if (w.length > 5 && w.endsWith("ed")) w = w.slice(0, -2);
  else if (w.length > 5 && w.endsWith("ing")) w = w.slice(0, -3);
  if (w.length > 3 && /([lpt])\1$/.test(w)) w = w.slice(0, -1); // cancelled → cancel, shipped → ship
  if (w.length > 4 && w.endsWith("e")) w = w.slice(0, -1); // create/created, price/priced
  return w;
}

/** Lowercased word tokens (letters/digits), keeping stop words. */
export function rawTokens(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[_\-/]/g, " ")
    .replace(/[^a-z0-9 ]+/g, " ")
    .split(/\s+/)
    .filter(Boolean);
}

/** Stemmed tokens with stop words removed. */
export function contentTokens(text: string): string[] {
  return rawTokens(text)
    .filter((t) => !STOPWORDS.has(t))
    .map(stem);
}

/** Stemmed tokens including stop words (used for phrase matching). */
export function stemmedTokens(text: string): string[] {
  return rawTokens(text).map(stem);
}

/** True if `phrase` tokens occur contiguously in `tokens`. */
export function containsPhrase(tokens: string[], phrase: string[]): boolean {
  if (phrase.length === 0 || phrase.length > tokens.length) return false;
  outer: for (let i = 0; i <= tokens.length - phrase.length; i++) {
    for (let j = 0; j < phrase.length; j++) if (tokens[i + j] !== phrase[j]) continue outer;
    return true;
  }
  return false;
}

/** True if all `phrase` tokens occur (in any order) within a window of len+3 tokens: "percentage of orders refunded" ≈ "percentage refunded". */
export function containsPhraseLoose(tokens: string[], phrase: string[]): boolean {
  if (phrase.length < 2) return false;
  const want = new Set(phrase);
  const window = phrase.length + 3;
  for (let i = 0; i < tokens.length; i++) {
    if (!want.has(tokens[i])) continue;
    const found = new Set<string>();
    for (let j = i; j < Math.min(tokens.length, i + window); j++) if (want.has(tokens[j])) found.add(tokens[j]);
    if (found.size === want.size) return true;
  }
  return false;
}
