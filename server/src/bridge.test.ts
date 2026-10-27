import { afterEach, describe, expect, it, vi } from "vitest";
import { DiscoveryAgent, pickCardsToDrop } from "./agent.js";
import { HttpQlooClient, decodeEntities } from "./http-qloo-client.js";
import { MockQlooClient } from "./mock-qloo-client.js";
import type { InsightQuery, QlooClient, QlooInsight, ResolvedEntity } from "./types.js";

const noOneLiners = async () => new Map<string, string>();

const example01 = {
  interests: [{ name: "Blade Runner 2049", type: "movie" }, { name: "The Left Hand of Darkness", type: "book" }, { name: "Disco Elysium", type: "video_game" }],
  targetType: "artist" as const,
  distance: 2 as const,
};
const example02 = {
  interests: [{ name: "Nausicaa", type: "movie" }, { name: "Braiding Sweetgrass", type: "book" }, { name: "Patagonia", type: "brand" }],
  targetType: "place" as const,
  city: "Kyoto",
  distance: 2 as const,
};

describe("taste bridge", () => {
  it("keeps the first query when every input is cited (example 01)", async () => {
    const result = await new DiscoveryAgent(new MockQlooClient(), noOneLiners).discover(example01);
    expect(result.trace.find((step) => step.stage === "bridge")?.detail)
      .toBe("Decision: every input is represented (Blade Runner 2049 4 · The Left Hand of Darkness 4 · Disco Elysium 2); kept first query");
    expect(result.bridgedInput).toBeUndefined();
    expect(result.recommendations.some((item) => item.bridgedFrom)).toBe(false);
  });

  it("runs one extra query for an uncited input and merges its cards (example 02)", async () => {
    const result = await new DiscoveryAgent(new MockQlooClient(), noOneLiners).discover(example02);
    const bridge = result.trace.find((step) => step.stage === "bridge")?.detail ?? "";
    expect(bridge).toMatch(/^Decision: Braiding Sweetgrass was cited by 0 of 10 cards → ran one extra query seeded with it alone; merged 2 cards/);
    expect(bridge).toContain("signal.interests.entities=mock:braiding-sweetgrass\n");
    expect(bridge).toContain("take=4");
    expect(result.bridgedInput).toBe("Braiding Sweetgrass");
    const ids = result.recommendations.map((item) => item.id);
    expect(ids).toHaveLength(10);
    expect(new Set(ids).size).toBe(10);
    const bridged = result.recommendations.filter((item) => item.bridgedFrom);
    expect(bridged).toHaveLength(2);
    expect(bridged.every((item) => item.bridgedFrom === "Braiding Sweetgrass" && item.becauseOf.includes("Braiding Sweetgrass"))).toBe(true);
  });

  it("drops the lowest-affinity cards but spares an input's only citation", () => {
    const resolved: ResolvedEntity[] = [{ id: "a", name: "A", type: "movie", tags: [] }, { id: "b", name: "B", type: "book", tags: [] }];
    const card = (id: string, score: number, sources: string[]): QlooInsight =>
      ({ id, name: id, type: "artist", description: "", affinitySourceIds: sources, affinitySourceNames: [], score });
    const cards = [card("strong", 0.9, ["a"]), card("onlyB", 0.1, ["b"]), card("weakA", 0.2, ["a"]), card("midA", 0.5, ["a"])];
    expect([...pickCardsToDrop(cards, resolved, 2)]).toEqual(["weakA", "midA"]);
  });

  it("does not run the bridge on a one-card refill", async () => {
    const queries: InsightQuery[] = [];
    const client = new MockQlooClient();
    const spy: QlooClient = {
      mode: "mock",
      search: (query, types) => client.search(query, types),
      insights: (query) => { queries.push(query); return client.insights(query); },
    };
    const result = await new DiscoveryAgent(spy, noOneLiners).refill(example02, [], "mock:place:museum-of-strangers");
    expect(queries).toHaveLength(1);
    expect(result.trace.some((step) => step.stage === "bridge")).toBe(false);
  });
});

describe("resolved-id reuse and name hygiene", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("skips /search entirely when every input carries an id", async () => {
    const client = new MockQlooClient();
    const result = await new DiscoveryAgent(client, noOneLiners).discover({
      ...example01,
      interests: [
        { name: "Blade Runner 2049", type: "movie", id: "mock:blade-runner-2049" },
        { name: "The Left Hand of Darkness", type: "book", id: "mock:left-hand-darkness" },
        { name: "Disco Elysium", type: "video_game", id: "mock:disco-elysium" },
      ],
    });
    expect(client.searchLog).toEqual([]);
    expect(result.trace[0]?.detail.split("\n")[0]).toBe("reused 3 resolved ids (no /search call)");
    expect(result.recommendations).toHaveLength(10);
  });

  it("decodes double-escaped HTML entities", () => {
    expect(decodeEntities("Earthsea Quartet &amp;amp; The Dispossessed")).toBe("Earthsea Quartet & The Dispossessed");
    expect(decodeEntities("Rock &#x26; Roll &#39;n&#39; &quot;Soul&quot;")).toBe("Rock & Roll 'n' \"Soul\"");
  });

  it("dedupes picker alternatives by name+type, decodes names, and passes images through", async () => {
    vi.stubGlobal("fetch", async (url: string) => {
      const parsed = new URL(url);
      if (parsed.pathname === "/search") {
        const results = parsed.searchParams.has("types")
          ? [
            { entity_id: "b1", name: "Left Hand", types: ["urn:entity:book"], properties: { publication_year: 1969 } },
            { entity_id: "b2", name: "Left Hand", types: ["urn:entity:book"], properties: { publication_year: 2004 } },
            { entity_id: "b3", name: "Left Hand &amp;amp; Right", types: ["urn:entity:book"] },
          ]
          : [{ entity_id: "m1", name: "Left Hand", types: ["urn:entity:movie"], properties: { release_year: 2001 } }];
        return new Response(JSON.stringify({ results }), { status: 200 });
      }
      return new Response(JSON.stringify({ results: { entities: [
        { entity_id: "x", name: "Pic &amp; Co", properties: { image: { url: "http://img.example/x.jpg" } }, query: { affinity: 0.7 } },
      ] } }), { status: 200 });
    });
    const client = new HttpQlooClient("test-key");
    const { matches } = await new DiscoveryAgent(client, noOneLiners).resolveMatches([{ name: "Left Hand", type: "book" }], true);
    expect(matches[0]?.entity).toMatchObject({ id: "b1", disambiguation: "1969" });
    expect(matches[0]?.alternatives?.map((entity) => [entity.id, entity.name, entity.type])).toEqual([
      ["b3", "Left Hand & Right", "book"],
      ["m1", "Left Hand", "movie"],
    ]);
    const [insight] = await client.insights({ targetType: "artist", signalEntityIds: ["b1"], excludeEntityIds: [], take: 1, explainability: true });
    expect(insight).toMatchObject({ name: "Pic & Co", imageUrl: "https://img.example/x.jpg", affinity: 0.7 });
  });
});
