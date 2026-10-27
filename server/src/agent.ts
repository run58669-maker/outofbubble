import { distanceProfile, obscurityBadge } from "./distance.js";
import { buildInsightsParams } from "./http-qloo-client.js";
import { rankMatches } from "./name-match.js";
import { generateOneLiners } from "./one-liners.js";
import {
  ENTITY_TYPES,
  TARGET_TYPES,
  type DiscoverInput,
  type DiscoveryResult,
  type InsightQuery,
  type InterestInput,
  type InterestMatch,
  type QlooClient,
  type QlooInsight,
  type Recommendation,
  type ResolvedEntity,
  type TraceStep,
} from "./types.js";

export const DEFAULT_CARD_COUNT = 10;

/** Without an explicit hint, inputs are searched as these types first (Qloo /search `types`). */
export const PREFERRED_INPUT_TYPES = ["movie", "book", "video_game", "tv_show", "artist", "podcast", "brand"] as const;
/** Place-like entities never win an unhinted input: "Patagonia" the brand, not the region. */
export const PLACE_INPUT_TYPES: ReadonlySet<string> = new Set(["locality", "place", "destination"]);
export const MAX_ALTERNATIVES = 3;
/** Looser name threshold for the picker's alternatives than for the automatic match. */
const ALTERNATIVE_MIN_SIMILARITY = 0.6;

/** Self-correction thresholds: fewer results than this, or less than half explained, triggers one relaxed retry. */
export const MIN_GOOD_RESULTS = 6;
export const MIN_EXPLAINED_SHARE = 0.5;
const POPULARITY_NOTCH = 0.15;
const POPULARITY_CEILING = 0.96;

function toInterest(value: string | InterestInput): InterestInput | undefined {
  if (typeof value === "string") return { name: value.trim() };
  if (typeof value !== "object" || value === null || typeof value.name !== "string") return undefined;
  const type = typeof value.type === "string" ? value.type.trim().toLowerCase() : "";
  const id = typeof value.id === "string" ? value.id.trim() : "";
  return {
    name: value.name.trim(),
    ...((ENTITY_TYPES as readonly string[]).includes(type) ? { type } : {}),
    ...(id && id.length <= 200 ? { id } : {}),
  };
}

/** Trim, drop empties, deduplicate by name (case-insensitive); keeps valid type hints and picked ids. */
export function normalizeInterests(interests: Array<string | InterestInput>): InterestInput[] {
  const seen = new Set<string>();
  return interests
    .map(toInterest)
    .filter((interest): interest is InterestInput => {
      if (!interest?.name) return false;
      const key = interest.name.toLocaleLowerCase();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
}

export function normalizeInterestNames(interests: Array<string | InterestInput>): string[] {
  return normalizeInterests(interests).map((interest) => interest.name);
}

export function validateDiscoverInput(input: DiscoverInput): Omit<DiscoverInput, "interests"> & { interests: InterestInput[] } {
  const interests = normalizeInterests(input.interests ?? []);
  if (interests.length < 3 || interests.length > 5) throw new Error("Choose 3 to 5 interests.");
  if (!TARGET_TYPES.includes(input.targetType)) throw new Error("Choose a supported target category.");
  if (![0, 1, 2].includes(input.distance)) throw new Error("Distance must be 0, 1, or 2.");
  if (input.targetType === "place" && !input.city?.trim()) throw new Error("Add a city for place discovery.");
  return { ...input, interests, city: input.city?.trim(), excludeIds: input.excludeIds ?? [] };
}

/** Every explainability source that maps to a resolved input, strongest score first (Qloo order breaks ties). */
export function buildExplanation(insight: QlooInsight, resolved: ResolvedEntity[]): { becauseOf: string[]; scores: Array<number | null>; text: string } {
  const byId = new Map(resolved.map((entity) => [entity.id, entity.name]));
  const resolvedNames = new Map(resolved.map((entity) => [entity.name.toLocaleLowerCase(), entity.name]));
  const scores = insight.affinitySourceScores ?? {};
  const found = new Map<string, number | null>();
  const add = (name: string | undefined, score: number | undefined) => {
    if (!name) return;
    const previous = found.get(name);
    if (previous === undefined) found.set(name, score ?? null);
    else if (score !== undefined && (previous === null || score > previous)) found.set(name, score);
  };
  insight.affinitySourceNames.forEach((name) => add(resolvedNames.get(name.toLocaleLowerCase()), scores[name]));
  insight.affinitySourceIds.forEach((id) => add(byId.get(id), scores[id]));
  const ordered = [...found].map(([name, score], index) => ({ name, score, index }))
    .sort((a, b) => (b.score ?? -Infinity) - (a.score ?? -Infinity) || a.index - b.index);
  return {
    becauseOf: ordered.map((entry) => entry.name),
    scores: ordered.map((entry) => entry.score),
    text: insight.description,
  };
}

/** One line per parameter actually sent to Qloo /v2/insights (same builder as HttpQlooClient). */
function formatInsightsQuery(query: InsightQuery): string {
  return [...buildInsightsParams(query)].map(([key, value]) => `${key}=${value}`).join("\n");
}

interface RunQuality { count: number; explained: number }

function quality(insights: QlooInsight[], resolved: ResolvedEntity[]): RunQuality {
  return { count: insights.length, explained: insights.filter((insight) => buildExplanation(insight, resolved).becauseOf.length > 0).length };
}

function describe(run: RunQuality): string {
  return `${run.count} results, ${run.explained}/${run.count} explained`;
}

/** The one looser setting the agent may try, or undefined when nothing is left to relax. */
export function relaxQuery(query: InsightQuery, reason: "too-few" | "unexplained"): { query: InsightQuery; change: string } | undefined {
  const biasSent = query.biasTrends !== undefined && query.targetType !== "book";
  const raiseCap = () => {
    if (query.popularityMax === undefined || query.popularityMax >= POPULARITY_CEILING) return undefined;
    const popularityMax = Math.round(Math.min(query.popularityMax + POPULARITY_NOTCH, POPULARITY_CEILING) * 100) / 100;
    return { query: { ...query, popularityMax }, change: `raised filter.popularity.max ${query.popularityMax} → ${popularityMax}` };
  };
  const dropBias = () => biasSent
    ? { query: { ...query, biasTrends: undefined }, change: `dropped bias.trends=${query.biasTrends}` }
    : undefined;
  const dropMin = () => query.popularityMin !== undefined
    ? { query: { ...query, popularityMin: undefined }, change: `dropped filter.popularity.min=${query.popularityMin}` }
    : undefined;
  return reason === "too-few" ? raiseCap() ?? dropBias() ?? dropMin() : dropBias() ?? raiseCap();
}

/** Lexicographic: enough results, then enough explained, then more results, then more explained. */
function better(candidate: RunQuality, current: RunQuality, minResults: number): boolean {
  const key = (run: RunQuality) => [
    run.count >= minResults ? 1 : 0,
    run.count > 0 && run.explained / run.count >= MIN_EXPLAINED_SHARE ? 1 : 0,
    run.count,
    run.explained,
  ];
  const [a, b] = [key(candidate), key(current)];
  for (let index = 0; index < a.length; index += 1) if (a[index] !== b[index]) return a[index]! > b[index]!;
  return false;
}

export class DiscoveryAgent {
  constructor(
    private readonly qloo: QlooClient,
    private readonly oneLiners: typeof generateOneLiners = generateOneLiners,
  ) {}

  get mode(): QlooClient["mode"] {
    return this.qloo.mode;
  }

  /**
   * Type-aware resolution. A hinted input searches only its type. An unhinted input searches the preferred
   * types and never accepts a place-like entity. If the typed search yields no name match, an untyped search
   * runs with the same name match and the same type rule.
   */
  private async resolveOne(interest: InterestInput, withAlternatives: boolean): Promise<{ match: InterestMatch; detail: string }> {
    const hint = interest.type;
    if (interest.id) {
      const entity: ResolvedEntity = { id: interest.id, name: interest.name, type: hint ?? "entity", tags: [] };
      return { match: { interest: interest.name, entity }, detail: `${interest.name} → ${entity.type} · ${entity.id} (picked by user)` };
    }
    const allowed = (entity: ResolvedEntity) => (hint ? entity.type === hint : !PLACE_INPUT_TYPES.has(entity.type));
    let typedHits: ResolvedEntity[] = [];
    let typedRejected = "";
    try {
      typedHits = await this.qloo.search(interest.name, hint ? [hint] : PREFERRED_INPUT_TYPES);
    } catch (error) {
      // A rejected `types` filter (any 4xx) must never fail discovery: fall through to the untyped search.
      const status = (error as { status?: unknown }).status;
      if (typeof status !== "number" || status < 400 || status >= 500) throw error;
      typedRejected = ` (typed search rejected with ${status}; retried without types)`;
    }
    let ranked = rankMatches(interest.name, typedHits.filter(allowed));
    let route = hint ? `typed: ${hint}` : "typed";
    let untypedHits: ResolvedEntity[] = [];
    if (!ranked.length || withAlternatives) {
      untypedHits = await this.qloo.search(interest.name);
      if (!ranked.length) {
        ranked = rankMatches(interest.name, untypedHits.filter(allowed));
        route = "untyped fallback";
      }
    }
    const entity = ranked[0];
    const match: InterestMatch = { interest: interest.name, entity };
    if (withAlternatives) {
      const seen = new Set(entity ? [entity.id] : []);
      match.alternatives = rankMatches(interest.name, [...typedHits, ...untypedHits], ALTERNATIVE_MIN_SIMILARITY)
        .filter((candidate) => !seen.has(candidate.id) && (seen.add(candidate.id), true))
        .slice(0, MAX_ALTERNATIVES);
    }
    const detail = (entity
      ? `${interest.name} → ${entity.type} · ${entity.id} (${route})`
      : `${interest.name} → not found (no close name match)`) + typedRejected;
    return { match, detail };
  }

  async resolveMatches(interests: Array<string | InterestInput>, withAlternatives = false): Promise<{ matches: InterestMatch[]; detail: string }> {
    const unique = normalizeInterests(interests).slice(0, 5);
    const results = await Promise.all(unique.map((interest) => this.resolveOne(interest, withAlternatives)));
    const header = `search.types=${PREFERRED_INPUT_TYPES.join(",")} (places only when hinted)`;
    return { matches: results.map((result) => result.match), detail: [header, ...results.map((result) => result.detail)].join("\n") };
  }

  async resolve(interests: Array<string | InterestInput>): Promise<ResolvedEntity[]> {
    return (await this.resolveMatches(interests)).matches.flatMap((match) => (match.entity ? [match.entity] : []));
  }

  async discover(rawInput: DiscoverInput): Promise<DiscoveryResult> {
    const input = validateDiscoverInput(rawInput);
    const trace: TraceStep[] = [];
    const { matches, detail: resolveDetail } = await this.resolveMatches(input.interests);
    const resolved = matches.flatMap((match) => (match.entity ? [match.entity] : []));
    const unresolved = matches.filter((match) => !match.entity).map((match) => match.interest);
    trace.push({ stage: "resolve", title: "Resolve", detail: resolveDetail });

    if (resolved.length === 0) {
      trace.push({ stage: "decide", title: "Decide", detail: "Decision: did not query Qloo insights because no input matched a real entity" });
      return {
        recommendations: [],
        resolved,
        unresolved,
        matches,
        trace,
        mode: this.qloo.mode,
        error: "None of those inputs matched a real Qloo entity, so nothing was searched. Check the spelling or try a better-known title.",
      };
    }

    const profile = distanceProfile(input.distance);
    const firstQuery: InsightQuery = {
      targetType: input.targetType,
      signalEntityIds: resolved.map((entity) => entity.id),
      excludeEntityIds: input.excludeIds ?? [],
      take: Math.min(Math.max(input.limit ?? DEFAULT_CARD_COUNT, 1), DEFAULT_CARD_COUNT),
      city: input.city,
      biasTrends: profile.biasTrends,
      popularityMin: profile.popularityMin,
      popularityMax: profile.popularityMax,
      explainability: true,
    };
    // Defensive slice: never show more cards than requested, even if the API ignores the page size.
    const run = async (query: InsightQuery) => (await this.qloo.insights(query)).slice(0, query.take);
    let insights = await run(firstQuery);
    let current = quality(insights, resolved);
    trace.push({ stage: "discover", title: "Discover", detail: `${formatInsightsQuery(firstQuery)}\nqloo.returned=${current.count}` });

    // Self-correction: one relaxed retry when the first page is thin or mostly unexplained.
    const minResults = Math.min(MIN_GOOD_RESULTS, firstQuery.take);
    const tooFew = current.count < minResults;
    const unexplained = !tooFew && current.explained / current.count < MIN_EXPLAINED_SHARE;
    let decision = `Decision: kept first query (${describe(current)})`;
    if (tooFew || unexplained) {
      const because = tooFew
        ? `only ${current.count} result${current.count === 1 ? "" : "s"} came back (fewer than ${minResults})`
        : `only ${current.explained}/${current.count} results were explained (under ${MIN_EXPLAINED_SHARE * 100}%)`;
      const relaxed = relaxQuery(firstQuery, tooFew ? "too-few" : "unexplained");
      if (!relaxed) {
        decision = `Decision: kept first query (${describe(current)}) because ${because} and no looser setting is left`;
      } else {
        const retried = await run(relaxed.query);
        const retryQuality = quality(retried, resolved);
        trace.push({ stage: "discover", title: "Discover (retry)", detail: `${formatInsightsQuery(relaxed.query)}\nqloo.returned=${retryQuality.count}` });
        const useRetry = better(retryQuality, current, minResults);
        decision = `Decision: ${relaxed.change} and retried because ${because}; kept the ${useRetry ? "retry" : "first query"} (${describe(useRetry ? retryQuality : current)})`;
        if (useRetry) {
          insights = retried;
          current = retryQuality;
        }
      }
    }
    trace.push({ stage: "decide", title: "Decide", detail: decision });

    const oneLiners = await this.oneLiners(insights);
    const recommendations: Recommendation[] = insights.map((insight, index) => {
      const explanation = buildExplanation(insight, resolved);
      return {
        id: insight.id,
        title: insight.name,
        type: input.targetType,
        becauseOf: explanation.becauseOf,
        becauseOfScores: explanation.scores,
        distance: input.distance,
        explanation: explanation.text,
        oneLiner: oneLiners.get(insight.id),
        artIndex: index % 10,
        explainabilityPresent: explanation.becauseOf.length > 0,
        popularity: insight.popularity,
        badge: obscurityBadge(insight.popularity),
      };
    });
    trace.push({
      stage: "explain",
      title: "Explain",
      detail: `result.count=${recommendations.length}\nexplainability.present=${recommendations.filter((item) => item.explainabilityPresent).length}/${recommendations.length}`,
    });

    return { recommendations, resolved, unresolved, matches, trace, mode: this.qloo.mode };
  }

  async refill(rawInput: DiscoverInput, currentIds: string[], knownId: string): Promise<DiscoveryResult> {
    const excludeIds = [...new Set([...(rawInput.excludeIds ?? []), ...currentIds, knownId])];
    const result = await this.discover({ ...rawInput, excludeIds, limit: 1 });
    result.trace.push({
      stage: "refill",
      title: "Refill",
      detail: `filter.exclude.entities=${excludeIds.join(",")}`,
    });
    return result;
  }
}
