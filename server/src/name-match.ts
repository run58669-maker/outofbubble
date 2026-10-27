import type { ResolvedEntity } from "./types.js";

/** Minimum normalized Levenshtein ratio for a fuzzy (non-exact, non-containment) match. */
export const MIN_NAME_SIMILARITY = 0.6;

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
 * Whole-word containment ("Blade Runner" ⊂ "Blade Runner 2049"). The shorter side must cover at
 * least half of the longer one, so a generic hit such as "Book" cannot match "Zzyzx Nonexistent Book".
 */
function contains(left: string, right: string): boolean {
  const [shorter, longer] = left.length <= right.length ? [left, right] : [right, left];
  if (shorter.length < 3 || shorter.length / longer.length < 0.5) return false;
  return ` ${longer} `.includes(` ${shorter} `);
}

/** 1 = exact (after normalization), 0.9 = containment, otherwise the Levenshtein ratio. */
export function nameScore(query: string, candidate: string): number {
  const left = normalizeName(query);
  const right = normalizeName(candidate);
  if (!left || !right) return 0;
  if (left === right) return 1;
  if (contains(left, right)) return 0.9;
  return levenshteinRatio(left, right);
}

/** Best-matching hit by name, Qloo's order breaking ties; undefined when nothing is close enough. */
export function pickBestMatch(query: string, hits: ResolvedEntity[]): ResolvedEntity | undefined {
  let best: { entity: ResolvedEntity; score: number } | undefined;
  for (const entity of hits) {
    const score = nameScore(query, entity.name);
    if (!best || score > best.score) best = { entity, score };
  }
  return best && best.score >= MIN_NAME_SIMILARITY ? best.entity : undefined;
}
