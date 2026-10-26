import { distanceProfile } from "./distance.js";
import { generateOneLiners } from "./one-liners.js";
import { TARGET_TYPES, type DiscoverInput, type DiscoveryResult, type QlooClient, type QlooInsight, type Recommendation, type ResolvedEntity, type TraceStep } from "./types.js";

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

function formatInsightsQuery(query: {
  targetType: string;
  signalEntityIds: string[];
  excludeEntityIds: string[];
  limit: number;
  city?: string;
  biasTrends: string;
  diversifyBy: string;
  popularityMin?: number;
  popularityMax?: number;
}): string {
  const parameters = [
    `filter.type=urn:entity:${query.targetType}`,
    `signal.interests.entities=${query.signalEntityIds.join(",")}`,
    `bias.trends=${query.biasTrends}`,
    `diversify.by=${query.diversifyBy}`,
    `limit=${query.limit}`,
  ];
  if (query.popularityMin !== undefined) parameters.push(`filter.popularity.min=${query.popularityMin}`);
  if (query.popularityMax !== undefined) parameters.push(`filter.popularity.max=${query.popularityMax}`);
  if (query.city) parameters.push(`filter.location.query=${query.city}`);
  parameters.push(`filter.exclude.entities=${query.excludeEntityIds.length ? query.excludeEntityIds.join(",") : "(not sent)"}`);
  parameters.push("feature.explainability=true");
  return parameters.join("\n");
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
    const matches = await Promise.all(unique.map(async (interest) => ({ interest, entity: (await this.qloo.search(interest))[0] })));
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
    const insightsQuery = {
      targetType: input.targetType,
      signalEntityIds: resolved.map((entity) => entity.id),
      excludeEntityIds: input.excludeIds ?? [],
      limit: Math.min(Math.max(input.limit ?? 8, 1), 10),
      city: input.city,
      biasTrends: profile.biasTrends,
      diversifyBy: profile.diversifyBy,
      popularityMin: profile.popularityMin,
      popularityMax: profile.popularityMax,
      explainability: true as const,
    };
    const insights = await this.qloo.insights(insightsQuery);
    trace.push({
      stage: "discover",
      title: "Insights query",
      detail: formatInsightsQuery(insightsQuery),
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
