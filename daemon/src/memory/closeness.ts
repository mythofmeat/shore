const STOPWORDS = new Set([
  "about", "after", "again", "all", "also", "am", "an", "and", "any", "are", "as", "at",
  "be", "been", "before", "but", "by", "can", "could", "did", "do", "does", "for", "from",
  "had", "has", "have", "he", "her", "here", "him", "his", "how", "if", "in", "into", "is",
  "it", "its", "just", "me", "my", "no", "not", "of", "on", "or", "our", "out", "she", "so",
  "some", "than", "that", "the", "their", "them", "then", "there", "these", "they", "this",
  "to", "too", "up", "us", "very", "was", "we", "were", "what", "when", "where", "which",
  "who", "why", "will", "with", "would", "you", "your",
]);

const WORD_CHAR = /[\p{Alphabetic}\p{Number}\p{Mark}_]/u;
const UNSPACED_SCRIPT = /^[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Thai}\p{Script=Lao}\p{Script=Khmer}\p{Script=Myanmar}]/u;

const DEFAULT_MIN_SIMILARITY = new Map<string, number>([["bge-small-en-v1.5", 0.7]]);

export function distinctiveTerms(terms: readonly string[]): string[] {
  const unique = [...new Set(terms)];
  const kept = unique.filter((term) => !STOPWORDS.has(term));
  return kept.length === 0 ? unique : kept;
}

export function startsAWord(textLower: string, term: string): boolean {
  if (UNSPACED_SCRIPT.test(term)) return textLower.includes(term);
  for (let at = textLower.indexOf(term); at >= 0; at = textLower.indexOf(term, at + 1)) {
    const before = Array.from(textLower.slice(Math.max(0, at - 2), at)).at(-1);
    if (before === undefined || !WORD_CHAR.test(before)) return true;
  }
  return false;
}

export function containsEveryTerm(textLower: string, terms: readonly string[]): boolean {
  return terms.length > 0 && terms.every((term) => startsAWord(textLower, term));
}

export function defaultMinSimilarity(modelId: string): number | undefined {
  return DEFAULT_MIN_SIMILARITY.get(modelId.toLowerCase().split("/").at(-1) ?? "");
}

export function meetsSimilarity(similarity: number | undefined, minSimilarity: number | undefined): boolean {
  return similarity !== undefined && minSimilarity !== undefined && similarity >= minSimilarity;
}
