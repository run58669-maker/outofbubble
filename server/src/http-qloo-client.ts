import type { InsightQuery, QlooClient, QlooInsight, ResolvedEntity } from "./types.js";

const QLOO_BASE_URL = "https://hackathon.api.qloo.com";

/**
 * `/search` `types` values Qloo accepted per its own 400 message (2026-10-27, list was alphabetical and truncated
 * after "urn:entity:destination"; the rest follows Qloo's documented spellings). Note `videogame`, not `video_game`.
 */
export const QLOO_SEARCH_TYPE_URNS: Readonly<Record<string, string>> = {
  actor: "urn:entity:actor",
  album: "urn:entity:album",
  artist: "urn:entity:artist",
  author: "urn:entity:author",
  book: "urn:entity:book",
  brand: "urn:entity:brand",
  destination: "urn:entity:destination",
  locality: "urn:entity:locality",
  movie: "urn:entity:movie",
  person: "urn:entity:person",
  place: "urn:entity:place",
  podcast: "urn:entity:podcast",
  tv_show: "urn:entity:tv_show",
  video_game: "urn:entity:videogame",
};

/** Internal type name for a Qloo URN suffix ("videogame" → "video_game"). */
const INTERNAL_TYPE: Readonly<Record<string, string>> = { videogame: "video_game" };

/** Carries the HTTP status so callers can tell a rejected filter (4xx) from an outage. */
export class QlooHttpError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
    this.name = "QlooHttpError";
  }
}

type JsonObject = Record<string, unknown>;

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringValue(...values: unknown[]): string | undefined {
  return values.find((value): value is string => typeof value === "string" && value.length > 0);
}

function numberValue(...values: unknown[]): number | undefined {
  return values.find((value): value is number => typeof value === "number" && Number.isFinite(value));
}

function arrayAt(payload: unknown, paths: string[][]): unknown[] {
  for (const path of paths) {
    let current: unknown = payload;
    for (const key of path) current = isObject(current) ? current[key] : undefined;
    if (Array.isArray(current)) return current;
  }
  return [];
}

/** Qloo search rows carry the type as `types: ["urn:entity:book"]` and/or `subtype`; strip the URN prefix. */
export function entityType(row: Record<string, unknown>, properties: Record<string, unknown>): string {
  const types = Array.isArray(row.types) ? row.types : [];
  const raw = stringValue(
    ...types.filter((item): item is string => typeof item === "string" && item.startsWith("urn:entity:")),
    row.subtype,
    row.type,
    properties.type,
    ...types,
  );
  if (!raw) return "entity";
  const type = raw.replace(/^urn:entity:/, "").split(":")[0]!;
  return INTERNAL_TYPE[type] ?? type;
}

/** Exactly the query parameters sent to GET /v2/insights; the agent trace prints this same list. */
export function buildInsightsParams(query: InsightQuery): URLSearchParams {
  const params = new URLSearchParams({
    "filter.type": `urn:entity:${query.targetType}`,
    "signal.interests.entities": query.signalEntityIds.join(","),
    "feature.explainability": "true",
    // Qloo paginates insights with `take` (+ `page`); an unknown `limit` is ignored and the default page of 20 comes back.
    take: String(query.take),
  });
  // Real API: book does not support trending requests (400), so bias.trends is skipped for it.
  if (query.biasTrends && query.targetType !== "book") params.set("bias.trends", query.biasTrends);
  if (query.excludeEntityIds.length) params.set("filter.exclude.entities", query.excludeEntityIds.join(","));
  if (query.city) params.set("filter.location.query", query.city);
  if (query.popularityMin !== undefined) params.set("filter.popularity.min", String(query.popularityMin));
  if (query.popularityMax !== undefined) params.set("filter.popularity.max", String(query.popularityMax));
  return params;
}

function extractTags(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => (typeof item === "string" ? item : isObject(item) ? stringValue(item.name, item.value) : undefined))
    .filter((item): item is string => Boolean(item));
}

export class HttpQlooClient implements QlooClient {
  readonly mode = "http" as const;

  constructor(private readonly apiKey: string) {
    if (!apiKey) throw new Error("QLOO_API_KEY is required for HttpQlooClient");
  }

  private async get(path: string, params: URLSearchParams): Promise<unknown> {
    const response = await fetch(`${QLOO_BASE_URL}${path}?${params.toString()}`, {
      headers: { "X-Api-Key": this.apiKey, Accept: "application/json" },
    });
    if (!response.ok) {
      const body = await response.text();
      throw new QlooHttpError(`Qloo ${path} failed (${response.status}): ${body.slice(0, 600)}`, response.status);
    }
    return response.json();
  }

  async search(query: string, types?: readonly string[]): Promise<ResolvedEntity[]> {
    const params = new URLSearchParams({ query });
    // Qloo /search `types`: comma-separated URNs, only values from Qloo's allowed list (unknown names are dropped).
    const urns = [...new Set((types ?? []).flatMap((type) => QLOO_SEARCH_TYPE_URNS[type] ?? []))];
    if (urns.length) params.set("types", urns.join(","));
    const payload = await this.get("/search", params);
    const rows = arrayAt(payload, [["results"], ["data"], ["results", "entities"]]);
    return rows.flatMap((row): ResolvedEntity[] => {
      if (!isObject(row)) return [];
      const properties = isObject(row.properties) ? row.properties : {};
      const id = stringValue(row.entity_id, row.id, properties.entity_id, properties.id);
      const name = stringValue(row.name, properties.name, row.title, properties.title);
      if (!id || !name) return [];
      return [{
        id,
        name,
        type: entityType(row, properties),
        tags: extractTags(row.tags ?? properties.tags),
      }];
    });
  }

  async insights(query: InsightQuery): Promise<QlooInsight[]> {
    const payload = await this.get("/v2/insights", buildInsightsParams(query));
    const rows = arrayAt(payload, [["results", "entities"], ["results"], ["data", "entities"], ["data"]]);
    return rows.flatMap((row): QlooInsight[] => {
      if (!isObject(row)) return [];
      const properties = isObject(row.properties) ? row.properties : {};
      const explainability = isObject(row.explainability) ? row.explainability : {};
      const id = stringValue(row.entity_id, row.id, properties.entity_id, properties.id);
      const name = stringValue(row.name, properties.name, row.title, properties.title);
      if (!id || !name) return [];
      // Real API nests explainability under row.query.explainability["signal.interests.entities"] as [{entity_id, score}].
      const realQuery = isObject(row.query) ? row.query : {};
      const realExplain = isObject(realQuery.explainability) ? realQuery.explainability : {};
      const sourceRows = [
        ...arrayAt(explainability, [["entities"], ["signals"], ["sources"]]),
        ...arrayAt(realExplain, [["signal.interests.entities"]]),
      ];
      const sources = sourceRows.filter(isObject);
      const affinitySourceScores: Record<string, number> = {};
      for (const source of sources) {
        const key = stringValue(source.entity_id, source.id, source.name, source.title);
        const score = numberValue(source.score, source.weight);
        if (key && score !== undefined) affinitySourceScores[key] = score;
      }
      return [{
        id,
        name,
        type: stringValue(row.type, properties.type) ?? query.targetType,
        description: stringValue(row.description, properties.description, row.summary, properties.short_description) ?? "",
        affinitySourceIds: sources.map((source) => stringValue(source.entity_id, source.id)).filter((item): item is string => Boolean(item)),
        affinitySourceNames: sources.map((source) => stringValue(source.name, source.title)).filter((item): item is string => Boolean(item)),
        affinitySourceScores,
        score: typeof row.score === "number" ? row.score : undefined,
        popularity: numberValue(row.popularity, properties.popularity, row.popularity_score, properties.popularity_score),
        trend: numberValue(row.trend, properties.trend, row.trend_score, properties.trend_score),
      }];
    });
  }
}
