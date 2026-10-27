import type { ResolvedEntity } from "./types.js";

/** Minimum normalized Levenshtein ratio for a fuzzy (non-exact, non-containment) match. */
export const MIN_NAME_SIMILARITY = 0.8;

const ARTICLES = new Set(["the", "a", "an"]);

/** Lowercase, strip accents and punctuation, drop the articles "the/a/an", collapse whitespace. */
export function normalizeName(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLocaleLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .split(" ")
    .filter((word) => word && !ARTICLES.has(word))
    .join(" ");
}

export function levenshteinRatio(left: string, right: string): number {
  if (left === right) return 1;
  if (!left.length || !right.length) return 0;
  let previous = Array.from({ length: right.length + 1 }, (_, index) => index);
  for (let i = 1; i <= left.length; i += 1) {
    const current = [i];
    for (let j = 1; j <= right.length; j += 1) {
      const cost = left[i - 1] === right[j - 1] ? 0 : 1;
      current[j] = Math.min(previous[j]! + 1, current[j - 1]! + 1, previous[j - 1]! + cost);
    }
    previous = current;
  }
  return 1 - previous[right.length]! / Math.max(left.length, right.length);
}

/**
 * One-directional whole-word containment: the *query* must sit inside the hit name
 * ("Nausicaa" ⊂ "Nausicaä of the Valley of the Wind"). A hit that is only a piece of the query
 * ("Nonexistent" inside "Flimzap Nonexistent", "Book" inside "Zzyzx Nonexistent Book") does not count.
 */
function queryContainedInHit(query: string, hit: string): boolean {
  if (query.length < 3 || query.length >= hit.length) return false;
  return ` ${hit} `.includes(` ${query} `);
}

/** 1 = exact (after normalization), 0.9 = query contained in the hit name, otherwise the Levenshtein ratio. */
export function nameScore(query: string, candidate: string): number {
  const left = normalizeName(query);
  const right = normalizeName(candidate);
  if (!left || !right) return 0;
  if (left === right) return 1;
  if (queryContainedInHit(left, right)) return 0.9;
  return levenshteinRatio(left, right);
}

/** Hits ranked by name score (Qloo's order breaks ties), keeping only those close enough to count as a match. */
export function rankMatches(query: string, hits: ResolvedEntity[], minScore = MIN_NAME_SIMILARITY): ResolvedEntity[] {
  return hits
    .map((entity, index) => ({ entity, index, score: nameScore(query, entity.name) }))
    .filter((entry) => entry.score >= minScore)
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .map((entry) => entry.entity);
}

/** Best-matching hit by name, Qloo's order breaking ties; undefined when nothing is close enough. */
export function pickBestMatch(query: string, hits: ResolvedEntity[]): ResolvedEntity | undefined {
  return rankMatches(query, hits)[0];
}
