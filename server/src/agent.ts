import { distanceProfile } from "./distance.js";
import { buildInsightsParams } from "./http-qloo-client.js";
import { pickBestMatch } from "./name-match.js";
import { generateOneLiners } from "./one-liners.js";
import { TARGET_TYPES, type DiscoverInput, type DiscoveryResult, type InsightQuery, type QlooClient, type QlooInsight, type Recommendation, type ResolvedEntity, type TraceStep } from "./types.js";

export const DEFAULT_CARD_COUNT = 10;

export function normalizeInterestNames(interests: string[]): string[] {
  const seen = new Set<string>();
  return interests
    .map((interest) => interest.trim())
    .filter((interest) => {
      const key = interest.toLocaleLowerCase();
      if (!interest || seen.has(key)) return false;
      seen.add(key);
      return true;
    });
}

export function validateDiscoverInput(input: DiscoverInput): DiscoverInput {
  const interests = normalizeInterestNames(input.interests ?? []);
  if (interests.length < 3 || interests.length > 5) throw new Error("Choose 3 to 5 interests.");
  if (!TARGET_TYPES.includes(input.targetType)) throw new Error("Choose a supported target category.");
  if (![0, 1, 2].includes(input.distance)) throw new Error("Distance must be 0, 1, or 2.");
  if (input.targetType === "place" && !input.city?.trim()) throw new Error("Add a city for place discovery.");
  return { ...input, interests, city: input.city?.trim(), excludeIds: input.excludeIds ?? [] };
}

export function buildExplanation(insight: QlooInsight, resolved: ResolvedEntity[]): { becauseOf: string[]; text: string } {
  const byId = new Map(resolved.map((entity) => [entity.id, entity.name]));
  const resolvedNames = new Map(resolved.map((entity) => [entity.name.toLocaleLowerCase(), entity.name]));
  const names = [
    ...insight.affinitySourceNames
      .map((name) => resolvedNames.get(name.toLocaleLowerCase()))
      .filter((name): name is string => Boolean(name)),
    ...insight.affinitySourceIds.map((id) => byId.get(id)).filter((name): name is string => Boolean(name)),
  ];
  const becauseOf = [...new Set(names)].slice(0, 2);
  return {
    becauseOf,
    text: insight.description,
  };
}

/** One line per parameter actually sent to Qloo /v2/insights (same builder as HttpQlooClient). */
function formatInsightsQuery(query: InsightQuery): string {
  return [...buildInsightsParams(query)].map(([key, value]) => `${key}=${value}`).join("\n");
}

export class DiscoveryAgent {
  constructor(
    private readonly qloo: QlooClient,
    private readonly oneLiners: typeof generateOneLiners = generateOneLiners,
  ) {}

  get mode(): QlooClient["mode"] {
    return this.qloo.mode;
  }

  private async resolveInputs(interests: string[]): Promise<{ resolved: ResolvedEntity[]; unresolved: string[]; detail: string }> {
    const unique = normalizeInterestNames(interests);
    const matches = await Promise.all(unique.map(async (interest) => ({ interest, entity: pickBestMatch(interest, await this.qloo.search(interest)) })));
    const resolved = matches.map((match) => match.entity).filter((entity): entity is ResolvedEntity => Boolean(entity));
    const unresolved = matches.filter((match) => !match.entity).map((match) => match.interest);
    const detail = matches.map((match) => match.entity
      ? `${match.interest} → ${match.entity.type} · ${match.entity.id}`
      : `${match.interest} → not found`).join("\n");
    return { resolved, unresolved, detail };
  }

  async resolve(interests: string[]): Promise<ResolvedEntity[]> {
    return (await this.resolveInputs(interests)).resolved;
  }

  async discover(rawInput: DiscoverInput): Promise<DiscoveryResult> {
    const input = validateDiscoverInput(rawInput);
    const trace: TraceStep[] = [];
    const { resolved, unresolved, detail: resolveDetail } = await this.resolveInputs(input.interests);
    trace.push({
      stage: "resolve",
      title: "Resolve",
      detail: resolveDetail,
    });

    if (resolved.length === 0) {
      trace.push({ stage: "explain", title: "Result", detail: "result.count=0" });
      return {
        recommendations: [],
        resolved,
        unresolved,
        trace,
        mode: this.qloo.mode,
        error: "None of those interests were found. Try at least one known title or name.",
      };
    }

    const profile = distanceProfile(input.distance);
    const insightsQuery: InsightQuery = {
      targetType: input.targetType,
      signalEntityIds: resolved.map((entity) => entity.id),
      excludeEntityIds: input.excludeIds ?? [],
      take: Math.min(Math.max(input.limit ?? DEFAULT_CARD_COUNT, 1), DEFAULT_CARD_COUNT),
      city: input.city,
      biasTrends: profile.biasTrends,
      diversifyBy: profile.diversifyBy,
      popularityMin: profile.popularityMin,
      popularityMax: profile.popularityMax,
      explainability: true,
    };
    const returned = await this.qloo.insights(insightsQuery);
    // Defensive: never show more cards than requested, even if the API ignores the page size.
    const insights = returned.slice(0, insightsQuery.take);
    trace.push({
      stage: "discover",
      title: "Insights query",
      detail: `${formatInsightsQuery(insightsQuery)}
qloo.returned=${returned.length}`,
    });

    const oneLiners = await this.oneLiners(insights);
    const recommendations: Recommendation[] = insights.map((insight, index) => {
      const explanation = buildExplanation(insight, resolved);
      return {
        id: insight.id,
        title: insight.name,
        type: input.targetType,
        becauseOf: explanation.becauseOf,
        distance: input.distance,
        explanation: explanation.text,
        oneLiner: oneLiners.get(insight.id),
        artIndex: index % 10,
        explainabilityPresent: explanation.becauseOf.length > 0,
        popularity: insight.popularity,
      };
    });
    trace.push({
      stage: "explain",
      title: "Result",
      detail: `result.count=${recommendations.length}\nexplainability.present=${recommendations.filter((item) => item.explainabilityPresent).length}/${recommendations.length}`,
    });

    return { recommendations, resolved, unresolved, trace, mode: this.qloo.mode };
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
