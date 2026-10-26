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
    expect(distanceProfile(0)).toMatchObject({ label: "Next door", biasTrends: "high", diversifyBy: "entities", popularityMin: 0.24 });
  });

  it("widens across-town discovery with tag diversity", () => {
    expect(distanceProfile(1)).toMatchObject({ label: "Across town", biasTrends: "low", diversifyBy: "tags", popularityMin: 0.08, popularityMax: 0.96 });
  });

  it("caps popularity at the farthest distance", () => {
    expect(distanceProfile(2)).toMatchObject({ label: "Out of the bubble", biasTrends: "low", diversifyBy: "tags", popularityMax: 0.8 });
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

  it("does not invent an entity for an unknown name", async () => {
    expect(await new MockQlooClient().search("A Thing We Just Invented")).toEqual([]);
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

  it("does not fabricate because-of evidence when explainability has no sources", () => {
    const insight: QlooInsight = { id: "x", name: "Result", type: "artist", description: "Still explained.", affinitySourceIds: [], affinitySourceNames: [] };
    expect(buildExplanation(insight, resolved)).toEqual({ becauseOf: [], text: "Still explained." });
  });
});

describe("agent loop", () => {
  it("returns eight cards with honest explainability flags and a three-step trace", async () => {
    const result = await new DiscoveryAgent(new MockQlooClient(), noOneLiners).discover(baseInput);
    expect(result.recommendations).toHaveLength(8);
    expect(result.recommendations.every((item) => item.explainabilityPresent === (item.becauseOf.length > 0))).toBe(true);
    expect(result.trace.map((item) => item.stage)).toEqual(["resolve", "discover", "explain"]);
    expect(result.trace[0]?.detail).toContain("Blade Runner 2049 → movie · mock:blade-runner-2049");
    expect(result.trace[1]?.detail).toContain("signal.interests.entities=mock:blade-runner-2049,mock:left-hand-darkness,mock:disco-elysium");
    expect(result.trace[1]?.detail).toContain("feature.explainability=true");
    expect(result.trace[2]?.detail).toContain("result.count=8");
    expect(result.mode).toBe("mock");
  });

  it("keeps the selected target type on every card", async () => {
    const result = await new DiscoveryAgent(new MockQlooClient(), noOneLiners).discover({ ...baseInput, targetType: "book" });
    expect(new Set(result.recommendations.map((item) => item.type))).toEqual(new Set(["book"]));
  });

  it("returns unknown inputs as unresolved and never cites them", async () => {
    const unknown = "A Thing We Just Invented";
    const result = await new DiscoveryAgent(new MockQlooClient(), noOneLiners).discover({
      ...baseInput,
      interests: ["Blade Runner 2049", "The Left Hand of Darkness", unknown],
    });
    expect(result.unresolved).toEqual([unknown]);
    expect(result.resolved).toHaveLength(2);
    expect(result.recommendations.flatMap((item) => item.becauseOf)).not.toContain(unknown);
    expect(result.trace[0]?.detail).toContain(`${unknown} → not found`);
  });

  it("returns a visible error result when every input is unresolved", async () => {
    const result = await new DiscoveryAgent(new MockQlooClient(), noOneLiners).discover({
      ...baseInput,
      interests: ["Unknown One", "Unknown Two", "Unknown Three"],
    });
    expect(result.recommendations).toEqual([]);
    expect(result.unresolved).toEqual(["Unknown One", "Unknown Two", "Unknown Three"]);
    expect(result.error).toMatch(/None/);
  });

  it("changes at least four of eight cards between adjacent distance stops", async () => {
    const agent = new DiscoveryAgent(new MockQlooClient(), noOneLiners);
    const sets = await Promise.all(([0, 1, 2] as const).map(async (value) =>
      new Set((await agent.discover({ ...baseInput, distance: value })).recommendations.map((item) => item.id))));
    const changed = (left: Set<string>, right: Set<string>) => 8 - [...left].filter((id) => right.has(id)).length;
    expect(changed(sets[0], sets[1])).toBeGreaterThanOrEqual(4);
    expect(changed(sets[1], sets[2])).toBeGreaterThanOrEqual(4);
  });

  it("serves type-correct, uniquely named mock results for every target", async () => {
    const client = new MockQlooClient();
    const targets = ["artist", "book", "podcast", "movie", "tv_show", "video_game", "place"] as const;
    const results = await Promise.all(targets.map((targetType) => client.insights({
      targetType,
      signalEntityIds: ["mock:blade-runner-2049"],
      excludeEntityIds: [],
      limit: 12,
      biasTrends: "low",
      diversifyBy: "tags",
      popularityMin: 0.08,
      popularityMax: 0.96,
      explainability: true,
    })));
    const names = results.flatMap((result) => result.map((item) => item.name));
    expect(results.every((result, index) => result.length === 12 && result.every((item) => item.type === targets[index]))).toBe(true);
    expect(new Set(names).size).toBe(names.length);
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
