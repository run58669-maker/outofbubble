export const TARGET_TYPES = [
  "artist",
  "book",
  "podcast",
  "movie",
  "tv_show",
  "video_game",
  "place",
] as const;

export type TargetType = (typeof TARGET_TYPES)[number];
export type Distance = 0 | 1 | 2;

/** Entity types an input may resolve to (Qloo search `types` values, without the `urn:entity:` prefix). */
export const ENTITY_TYPES = [
  "album", "artist", "book", "brand", "destination", "locality", "movie", "person", "place", "podcast", "tv_show", "video_game",
] as const;

export interface ResolvedEntity {
  id: string;
  name: string;
  type: string;
  tags: string[];
  /** Short disambiguator from the Qloo search row (year, author…), when Qloo gave one. */
  disambiguation?: string;
}

/** One user input. `type` is an explicit hint; `id` pins an entity the user picked from the alternatives. */
export interface InterestInput {
  name: string;
  type?: string;
  id?: string;
}

export interface InterestMatch {
  interest: string;
  entity?: ResolvedEntity;
  alternatives?: ResolvedEntity[];
}

export interface InsightQuery {
  targetType: TargetType;
  signalEntityIds: string[];
  excludeEntityIds: string[];
  /** Qloo /v2/insights page size (`take`). Qloo ignores `limit`. */
  take: number;
  city?: string;
  /** Omitted when the agent's self-correction step drops the trend bias. */
  biasTrends?: "low" | "high";
  popularityMin?: number;
  popularityMax?: number;
  explainability: true;
}

export interface QlooInsight {
  id: string;
  name: string;
  type: string;
  description: string;
  affinitySourceIds: string[];
  affinitySourceNames: string[];
  /** Explainability strength per source, keyed by source entity id (or by name when Qloo gave no id). */
  affinitySourceScores?: Record<string, number>;
  score?: number;
  /** Qloo affinity for this result (`query.affinity`), falling back to `score`. */
  affinity?: number;
  popularity?: number;
  trend?: number;
  /** Entity image from the Qloo payload (`properties.image.url`), when present. */
  imageUrl?: string;
  /** Tag names Qloo attaches to the result entity (`tags[].name`); the taste bridge's relevance gate reads them. */
  tags?: string[];
}

export interface QlooClient {
  readonly mode: "mock" | "http";
  /** `types` are bare entity types ("movie"); the HTTP client sends them as Qloo's `types` URN filter. */
  search(query: string, types?: readonly string[]): Promise<ResolvedEntity[]>;
  insights(query: InsightQuery): Promise<QlooInsight[]>;
}

export interface TraceStep {
  stage: "cache" | "resolve" | "discover" | "decide" | "bridge" | "explain" | "refill";
  title: string;
  detail: string;
}

export interface Recommendation {
  id: string;
  title: string;
  type: TargetType;
  /** Every explainability source Qloo named that maps to a resolved input, strongest first. */
  becauseOf: string[];
  /** Score for each `becauseOf` entry (same order); null when Qloo gave none. */
  becauseOfScores: Array<number | null>;
  distance: Distance;
  explanation: string;
  oneLiner?: string;
  artIndex: number;
  explainabilityPresent: boolean;
  popularity?: number;
  /** Popularity badge (see BADGE_THRESHOLDS in distance.ts). */
  badge: "well known" | "familiar" | "deep cut" | "reach unknown";
  /**
   * Set on cards from the taste-bridge query: the input that query was seeded with alone. The matching `becauseOf`
   * entry is *seeded* by the agent (score null), not a Qloo citation in the combined query.
   */
  bridgedFrom?: string;
  /** Bridge cards only: the candidate's tags it shares with the user's other inputs (why it passed the gate). */
  sharedTags?: string[];
  /** Qloo entity image, when the payload had one. */
  imageUrl?: string;
}

export interface DiscoverInput {
  interests: Array<string | InterestInput>;
  targetType: TargetType;
  distance: Distance;
  city?: string;
  excludeIds?: string[];
  limit?: number;
}

export interface DiscoveryResult {
  recommendations: Recommendation[];
  resolved: ResolvedEntity[];
  unresolved: string[];
  /** Per-input resolution in input order; drives the type chip on each input token. */
  matches: InterestMatch[];
  trace: TraceStep[];
  mode: "mock" | "http";
  /** The input the taste bridge ran an extra query for (cited by 0 cards in the first query). */
  bridgedInput?: string;
  /** Taste-bridge numbers when its extra query ran: candidates fetched, passed the relevance gate, merged. */
  bridge?: { input: string; candidates: number; passed: number; merged: number };
  error?: string;
}
