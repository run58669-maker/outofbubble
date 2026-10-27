import { afterEach, describe, expect, it, vi } from "vitest";
import { DiscoveryAgent, PREFERRED_INPUT_TYPES, buildExplanation, normalizeInterestNames, validateDiscoverInput } from "./agent.js";
import { distanceProfile, obscurityBadge } from "./distance.js";
import { HttpQlooClient } from "./http-qloo-client.js";
import { MockQlooClient } from "./mock-qloo-client.js";
import { nameScore } from "./name-match.js";
import type { InsightQuery, QlooClient, QlooInsight, ResolvedEntity } from "./types.js";

const baseInput = {
  interests: ["Blade Runner 2049", "The Left Hand of Darkness", "Disco Elysium"],
  targetType: "artist" as const,
  distance: 2 as const,
};

const noOneLiners = async () => new Map<string, string>();

describe("distance mapping", () => {
  it("keeps next-door discovery popular and entity-led", () => {
    expect(distanceProfile(0)).toEqual({ label: "Next door", biasTrends: "high", popularityMin: 0.24 });
  });

  it("widens across-town discovery with a popularity band", () => {
    expect(distanceProfile(1)).toEqual({ label: "Across town", biasTrends: "low", popularityMin: 0.08, popularityMax: 0.96 });
  });

  it("caps far-out popularity below the well-known badge", () => {
    expect(distanceProfile(2)).toEqual({ label: "Out of the bubble", biasTrends: "low", popularityMax: 0.65 });
    expect(obscurityBadge(distanceProfile(2).popularityMax)).not.toBe("well known");
  });

  it("labels badges at 0.85 and 0.6", () => {
    expect([0.9, 0.85, 0.84, 0.6, 0.59, undefined].map(obscurityBadge))
      .toEqual(["well known", "well known", "familiar", "familiar", "deep cut", "reach unknown"]);
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
    const first = await client.insights({ targetType: "artist", signalEntityIds: ["mock:blade-runner-2049"], excludeEntityIds: [], take: 2, biasTrends: "low", explainability: true });
    const second = await client.insights({ targetType: "artist", signalEntityIds: ["mock:blade-runner-2049"], excludeEntityIds: [first[0]!.id], take: 2, biasTrends: "low", explainability: true });
    expect(second.map((item) => item.id)).not.toContain(first[0]!.id);
  });
});

describe("http Qloo client", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("resolves by best name match, parses the URN type, and leaves unrelated hits unresolved", async () => {
    const hits: Record<string, unknown[]> = {
      "The Left Hand of Darkness": [
        { entity_id: "junk", name: "NNNKS Competent Careers Pvt.Ltd.", types: ["urn:entity:brand"] },
        { entity_id: "lhod", name: "The Left Hand of Darkness", types: ["urn:entity:book"], subtype: "urn:entity:book" },
      ],
      "Blade Runner 2049": [{ entity_id: "br", name: "Blade Runner 2049", types: ["urn:entity:movie"] }],
      "Zzyzx Nonexistent Book": [
        { entity_id: "b1", name: "Book", types: ["urn:entity:brand"] },
        { entity_id: "b2", name: "Zyzzyva Press", types: ["urn:entity:brand"] },
      ],
    };
    vi.stubGlobal("fetch", async (url: string) => {
      const parsed = new URL(url);
      const body = parsed.pathname === "/search" ? { results: hits[parsed.searchParams.get("query") ?? ""] ?? [] } : { results: { entities: [] } };
      return new Response(JSON.stringify(body), { status: 200 });
    });
    const result = await new DiscoveryAgent(new HttpQlooClient("test-key"), noOneLiners).discover({
      ...baseInput,
      interests: ["The Left Hand of Darkness", "Blade Runner 2049", "Zzyzx Nonexistent Book"],
    });
    expect(result.resolved.map((entity) => [entity.id, entity.type])).toEqual([["lhod", "book"], ["br", "movie"]]);
    expect(result.unresolved).toEqual(["Zzyzx Nonexistent Book"]);
    expect(result.trace[0]?.detail).toContain("The Left Hand of Darkness → book · lhod");
    expect(result.trace[0]?.detail).toContain("Zzyzx Nonexistent Book → not found");
  });

  it("pages insights with take, not limit", async () => {
    const urls: string[] = [];
    vi.stubGlobal("fetch", async (url: string) => {
      urls.push(url);
      return new Response(JSON.stringify({ results: { entities: [] } }), { status: 200 });
    });
    await new HttpQlooClient("test-key").insights({ targetType: "artist", signalEntityIds: ["a"], excludeEntityIds: [], take: 10, biasTrends: "low", explainability: true });
    const params = new URL(urls[0]!).searchParams;
    expect(params.get("take")).toBe("10");
    expect(params.has("limit")).toBe(false);
  });
});

describe("explanation rendering", () => {
  const resolved: ResolvedEntity[] = [
    { id: "one", name: "First Love", type: "book", tags: [] },
    { id: "two", name: "Second Love", type: "movie", tags: [] },
  ];

  it("renders named explainability sources", () => {
    const insight: QlooInsight = { id: "x", name: "Result", type: "artist", description: "A useful Qloo explanation.", affinitySourceIds: [], affinitySourceNames: ["First Love", "Second Love"] };
    expect(buildExplanation(insight, resolved)).toEqual({ becauseOf: ["First Love", "Second Love"], scores: [null, null], text: "A useful Qloo explanation." });
  });

  it("keeps every source (no cut at two), strongest score first", () => {
    const three: ResolvedEntity[] = [...resolved, { id: "three", name: "Third Love", type: "video_game", tags: [] }];
    const insight: QlooInsight = {
      id: "x", name: "Result", type: "artist", description: "",
      affinitySourceIds: ["one", "two", "three"], affinitySourceNames: [],
      affinitySourceScores: { one: 0.2, two: 0.9, three: 0.5 },
    };
    expect(buildExplanation(insight, three)).toMatchObject({ becauseOf: ["Second Love", "Third Love", "First Love"], scores: [0.9, 0.5, 0.2] });
  });

  it("maps source ids back to input names", () => {
    const insight: QlooInsight = { id: "x", name: "Result", type: "artist", description: "Linked by id.", affinitySourceIds: ["two"], affinitySourceNames: [] };
    expect(buildExplanation(insight, resolved).becauseOf).toEqual(["Second Love"]);
  });

  it("does not fabricate because-of evidence when explainability has no sources", () => {
    const insight: QlooInsight = { id: "x", name: "Result", type: "artist", description: "Still explained.", affinitySourceIds: [], affinitySourceNames: [] };
    expect(buildExplanation(insight, resolved)).toEqual({ becauseOf: [], scores: [], text: "Still explained." });
  });
});

describe("agent loop", () => {
  it("returns ten cards with honest explainability flags and a resolve/discover/decide/explain trace", async () => {
    const result = await new DiscoveryAgent(new MockQlooClient(), noOneLiners).discover(baseInput);
    expect(result.recommendations).toHaveLength(10);
    expect(result.recommendations.every((item) => item.explainabilityPresent === (item.becauseOf.length > 0))).toBe(true);
    expect(result.recommendations.every((item) => item.badge !== "well known")).toBe(true);
    expect(result.trace.map((item) => item.stage)).toEqual(["resolve", "discover", "decide", "explain"]);
    expect(result.trace[2]?.detail).toMatch(/^Decision: kept first query \(10 results, \d+\/10 explained\)$/);
    expect(result.trace[0]?.detail).toContain("Blade Runner 2049 → movie · mock:blade-runner-2049");
    expect(result.trace[1]?.detail).toContain("signal.interests.entities=mock:blade-runner-2049,mock:left-hand-darkness,mock:disco-elysium");
    expect(result.trace[1]?.detail).toContain("feature.explainability=true");
    expect(result.trace[1]?.detail).toContain("take=10");
    expect(result.trace[1]?.detail).not.toContain("limit=");
    expect(result.trace[1]?.detail).not.toContain("diversify.by");
    expect(result.trace[1]?.detail).toContain("qloo.returned=10");
    expect(result.trace[3]?.detail).toContain("result.count=10");
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

  it("changes at least four of ten cards between adjacent distance stops", async () => {
    const agent = new DiscoveryAgent(new MockQlooClient(), noOneLiners);
    const sets = await Promise.all(([0, 1, 2] as const).map(async (value) =>
      new Set((await agent.discover({ ...baseInput, distance: value })).recommendations.map((item) => item.id))));
    const changed = (left: Set<string>, right: Set<string>) => left.size - [...left].filter((id) => right.has(id)).length;
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
      take: 12,
      biasTrends: "low",
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
