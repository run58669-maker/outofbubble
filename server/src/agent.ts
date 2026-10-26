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
  const names = [
    ...insight.affinitySourceNames,
    ...insight.affinitySourceIds.map((id) => byId.get(id)).filter((name): name is string => Boolean(name)),
  ];
  const becauseOf = [...new Set(names)].slice(0, 2);
  const fallback = resolved.slice(0, 2).map((entity) => entity.name);
  return {
    becauseOf: becauseOf.length > 0 ? becauseOf : fallback,
    text: insight.description || "Qloo found an unexpected bridge across your interests.",
  };
}

export class DiscoveryAgent {
  constructor(
    private readonly qloo: QlooClient,
    private readonly oneLiners: typeof generateOneLiners = generateOneLiners,
  ) {}

  async resolve(interests: string[]): Promise<ResolvedEntity[]> {
    const unique = normalizeInterestNames(interests);
    return (await Promise.all(unique.map(async (interest) => (await this.qloo.search(interest))[0])))
      .filter((entity): entity is ResolvedEntity => Boolean(entity));
  }

  async discover(rawInput: DiscoverInput): Promise<DiscoveryResult> {
    const input = validateDiscoverInput(rawInput);
    const trace: TraceStep[] = [];
    const resolved = await this.resolve(input.interests);
    if (resolved.length !== input.interests.length) throw new Error("One or more interests could not be resolved by Qloo.");
    trace.push({
      stage: "resolve",
      title: "Resolve",
      detail: `Matched ${resolved.length} interests across ${new Set(resolved.map((item) => item.type)).size} categories.`,
    });

    const profile = distanceProfile(input.distance);
    const insights = await this.qloo.insights({
      targetType: input.targetType,
      signalEntityIds: resolved.map((entity) => entity.id),
      excludeEntityIds: input.excludeIds ?? [],
      limit: Math.min(Math.max(input.limit ?? 8, 1), 10),
      city: input.city,
      biasTrends: profile.biasTrends,
      diversifyBy: profile.diversifyBy,
      popularityMin: profile.popularityMin,
      popularityMax: profile.popularityMax,
      explainability: true,
    });
    trace.push({
      stage: "discover",
      title: "Discover",
      detail: `Asked Qloo for ${profile.label.toLowerCase()} ${input.targetType.replace("_", " ")} connections with explainability on.`,
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
        explainabilityPresent: insight.affinitySourceIds.length > 0 || insight.affinitySourceNames.length > 0,
      };
    });
    trace.push({
      stage: "explain",
      title: "Explain",
      detail: `Kept ${recommendations.length} paths and linked each one back to the interests that pulled it in.`,
    });

    return { recommendations, resolved, trace, mode: this.qloo.mode };
  }

  async refill(rawInput: DiscoverInput, currentIds: string[], knownId: string): Promise<DiscoveryResult> {
    const excludeIds = [...new Set([...(rawInput.excludeIds ?? []), ...currentIds, knownId])];
    const result = await this.discover({ ...rawInput, excludeIds, limit: 1 });
    result.trace.push({
      stage: "refill",
      title: "Refill",
      detail: `Excluded the known item and refilled from a new Qloo path.`,
    });
    return result;
  }
}
