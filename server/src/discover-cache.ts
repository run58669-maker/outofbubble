import type { DiscoverInput, DiscoveryResult } from "./types.js";

export const DISCOVER_CACHE_TTL_MS = 10 * 60_000;
export const DISCOVER_CACHE_MAX = 200;

/** Normalized request key: sorted inputs (id, else lowercase name, plus type), target, distance, city, sorted excludes. */
export function discoverCacheKey(input: DiscoverInput): string {
  const interests = input.interests.map((item) => typeof item === "string"
    ? `n:${item.trim().toLocaleLowerCase()}|`
    : `${item.id ? `i:${item.id}` : `n:${item.name.trim().toLocaleLowerCase()}`}|${item.type ?? ""}`).sort();
  return JSON.stringify([
    interests, input.targetType, input.distance, input.city?.trim().toLocaleLowerCase() ?? "",
    [...new Set(input.excludeIds ?? [])].sort(), input.limit ?? null,
  ]);
}

/** Small TTL + LRU cache so re-running the same demo does not hit Qloo again. */
export class DiscoverCache {
  private readonly entries = new Map<string, { at: number; value: DiscoveryResult }>();

  constructor(
    private readonly ttlMs = DISCOVER_CACHE_TTL_MS,
    private readonly max = DISCOVER_CACHE_MAX,
    private readonly now: () => number = Date.now,
  ) {}

  /** A copy of the cached result with a "cache hit" step first in its trace, or undefined. */
  get(key: string): DiscoveryResult | undefined {
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    this.entries.delete(key);
    if (this.now() - entry.at > this.ttlMs) return undefined;
    this.entries.set(key, entry);
    const copy = structuredClone(entry.value);
    const age = Math.round((this.now() - entry.at) / 1000);
    copy.trace.unshift({ stage: "cache", title: "Cache", detail: `cache hit: same request ${age} s ago; served from memory, no Qloo call` });
    return copy;
  }

  set(key: string, value: DiscoveryResult) {
    if (value.error) return;
    this.entries.delete(key);
    this.entries.set(key, { at: this.now(), value: structuredClone(value) });
    while (this.entries.size > this.max) this.entries.delete(this.entries.keys().next().value!);
  }

  get size(): number {
    return this.entries.size;
  }
}
