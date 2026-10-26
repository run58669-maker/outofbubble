import { describe, expect, it } from "vitest";
import { DiscoveryAgent, buildExplanation, normalizeInterestNames, validateDiscoverInput } from "./agent.js";
import { distanceProfile } from "./distance.js";
import { MockQlooClient } from "./mock-qloo-client.js";
import type { QlooInsight, ResolvedEntity } from "./types.js";

const baseInput = {
  interests: ["Blade Runner 2049", "The Left Hand of Darkness", "Disco Elysium"],
  targetType: "artist" as const,
  distance: 2 as const,
};

const noOneLiners = async () => new Map<string, string>();

describe("distance mapping", () => {
  it("keeps next-door discovery popular and entity-led", () => {
    expect(distanceProfile(0)).toMatchObject({ label: "Next door", biasTrends: "high", diversifyBy: "entities", popularityMin: 0.55 });
  });

  it("widens across-town discovery with tag diversity", () => {
    expect(distanceProfile(1)).toMatchObject({ label: "Across town", biasTrends: "low", diversifyBy: "tags", popularityMin: 0.2 });
  });

  it("caps popularity at the farthest distance", () => {
    expect(distanceProfile(2)).toMatchObject({ label: "Out of the bubble", biasTrends: "low", diversifyBy: "tags", popularityMax: 0.45 });
  });
});

describe("input handling", () => {
  it("trims and deduplicates interest names case-insensitively", () => {
    expect(normalizeInterestNames(["  Hades ", "hades", "Circe", ""])).toEqual(["Hades", "Circe"]);
  });

  it("rejects fewer than three interests", () => {
    expect(() => validateDiscoverInput({ ...baseInput, interests: ["One", "Two"] })).toThrow("3 to 5");
  });

  it("rejects more than five interests", () => {
    expect(() => validateDiscoverInput({ ...baseInput, interests: ["1", "2", "3", "4", "5", "6"] })).toThrow("3 to 5");
  });

  it("requires a city for place discovery", () => {
    expect(() => validateDiscoverInput({ ...baseInput, targetType: "place" })).toThrow("city");
  });
});

describe("mock Qloo client", () => {
  it("resolves a known fixture", async () => {
    const [entity] = await new MockQlooClient().search("Blade Runner 2049");
    expect(entity).toMatchObject({ id: "mock:blade-runner-2049", type: "movie" });
  });

  it("resolves an arbitrary name without an environment variable", async () => {
    const [entity] = await new MockQlooClient().search("A Thing We Just Invented");
    expect(entity?.id).toBe("mock:interest:a-thing-we-just-invented");
  });

  it("honors exclusions in insights", async () => {
    const client = new MockQlooClient();
    const first = await client.insights({ targetType: "artist", signalEntityIds: ["mock:blade-runner-2049"], excludeEntityIds: [], limit: 2, biasTrends: "low", diversifyBy: "tags", explainability: true });
    const second = await client.insights({ targetType: "artist", signalEntityIds: ["mock:blade-runner-2049"], excludeEntityIds: [first[0]!.id], limit: 2, biasTrends: "low", diversifyBy: "tags", explainability: true });
    expect(second.map((item) => item.id)).not.toContain(first[0]!.id);
  });
});

describe("explanation rendering", () => {
  const resolved: ResolvedEntity[] = [
    { id: "one", name: "First Love", type: "book", tags: [] },
    { id: "two", name: "Second Love", type: "movie", tags: [] },
  ];

  it("renders named explainability sources", () => {
    const insight: QlooInsight = { id: "x", name: "Result", type: "artist", description: "A useful Qloo explanation.", affinitySourceIds: [], affinitySourceNames: ["First Love", "Second Love"] };
    expect(buildExplanation(insight, resolved)).toEqual({ becauseOf: ["First Love", "Second Love"], text: "A useful Qloo explanation." });
  });

  it("maps source ids back to input names", () => {
    const insight: QlooInsight = { id: "x", name: "Result", type: "artist", description: "Linked by id.", affinitySourceIds: ["two"], affinitySourceNames: [] };
    expect(buildExplanation(insight, resolved).becauseOf).toEqual(["Second Love"]);
  });

  it("falls back to the first two inputs when explainability has no sources", () => {
    const insight: QlooInsight = { id: "x", name: "Result", type: "artist", description: "Still explained.", affinitySourceIds: [], affinitySourceNames: [] };
    expect(buildExplanation(insight, resolved).becauseOf).toEqual(["First Love", "Second Love"]);
  });
});

describe("agent loop", () => {
  it("returns eight cards with because-of evidence and a three-step trace", async () => {
    const result = await new DiscoveryAgent(new MockQlooClient(), noOneLiners).discover(baseInput);
    expect(result.recommendations).toHaveLength(8);
    expect(result.recommendations.every((item) => item.becauseOf.length > 0)).toBe(true);
    expect(result.trace.map((item) => item.stage)).toEqual(["resolve", "discover", "explain"]);
    expect(result.mode).toBe("mock");
  });

  it("keeps the selected target type on every card", async () => {
    const result = await new DiscoveryAgent(new MockQlooClient(), noOneLiners).discover({ ...baseInput, targetType: "book" });
    expect(new Set(result.recommendations.map((item) => item.type))).toEqual(new Set(["book"]));
  });

  it("refills with a card absent from the current result set", async () => {
    const agent = new DiscoveryAgent(new MockQlooClient(), noOneLiners);
    const initial = await agent.discover(baseInput);
    const known = initial.recommendations[0]!;
    const refill = await agent.refill(baseInput, initial.recommendations.map((item) => item.id), known.id);
    expect(refill.recommendations).toHaveLength(1);
    expect(initial.recommendations.map((item) => item.id)).not.toContain(refill.recommendations[0]!.id);
    expect(refill.trace.at(-1)?.stage).toBe("refill");
  });
});
