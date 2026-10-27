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

export interface ResolvedEntity {
  id: string;
  name: string;
  type: string;
  tags: string[];
}

export interface InsightQuery {
  targetType: TargetType;
  signalEntityIds: string[];
  excludeEntityIds: string[];
  /** Qloo /v2/insights page size (`take`). Qloo ignores `limit`. */
  take: number;
  city?: string;
  biasTrends: "low" | "high";
  diversifyBy: "entities" | "tags";
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
  score?: number;
  popularity?: number;
  trend?: number;
}

export interface QlooClient {
  readonly mode: "mock" | "http";
  search(query: string): Promise<ResolvedEntity[]>;
  insights(query: InsightQuery): Promise<QlooInsight[]>;
}

export interface TraceStep {
  stage: "resolve" | "discover" | "explain" | "refill";
  title: string;
  detail: string;
}

export interface Recommendation {
  id: string;
  title: string;
  type: TargetType;
  becauseOf: string[];
  distance: Distance;
  explanation: string;
  oneLiner?: string;
  artIndex: number;
  explainabilityPresent: boolean;
  popularity?: number;
}

export interface DiscoverInput {
  interests: string[];
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
  trace: TraceStep[];
  mode: "mock" | "http";
  error?: string;
}
