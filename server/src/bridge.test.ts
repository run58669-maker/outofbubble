import { afterEach, describe, expect, it, vi } from "vitest";
import { BRIDGE_TAKE, DiscoveryAgent, pickCardsToDrop, sharedTags } from "./agent.js";
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

  it("merges only candidates that pass the relevance gate (example 02, passes)", async () => {
    const result = await new DiscoveryAgent(new MockQlooClient(), noOneLiners).discover(example02);
    const bridge = result.trace.find((step) => step.stage === "bridge")?.detail ?? "";
    expect(bridge.split("\n")[0]).toBe("Decision: Braiding Sweetgrass was cited by 0/10 → fetched 2 candidates seeded with it; "
      + "1 passed the relevance gate (shared tags ≥ 2 with your other interests: \"Moss Courtyard\" 3); merged 1, replaced 1");
    expect(bridge).toContain("signal.interests.entities=mock:braiding-sweetgrass\n");
    expect(bridge).toContain(`take=${BRIDGE_TAKE}`);
    expect(BRIDGE_TAKE).toBe(8);
    expect(result.bridge).toEqual({ input: "Braiding Sweetgrass", candidates: 2, passed: 1, merged: 1 });
    const ids = result.recommendations.map((item) => item.id);
    expect(ids).toHaveLength(10);
    expect(new Set(ids).size).toBe(10);
    const bridged = result.recommendations.filter((item) => item.bridgedFrom);
    expect(bridged.map((item) => item.title)).toEqual(["Moss Courtyard"]);
    // Seeded, not cited: the only "because of" is the seed, with no Qloo score, and it does not count as explained.
    expect(bridged[0]).toMatchObject({
      bridgedFrom: "Braiding Sweetgrass", becauseOf: ["Braiding Sweetgrass"], becauseOfScores: [null],
      explainabilityPresent: false, sharedTags: ["ecology", "adventure", "outdoors"],
    });
  });

  it("never merges a candidate with fewer than 2 shared tags", async () => {
    const result = await new DiscoveryAgent(new MockQlooClient(), noOneLiners).discover(example02);
    // "Reciprocity Lab Café" came back in the same candidate pool but shares only "activism" with Nausicaa + Patagonia.
    expect(result.recommendations.some((item) => item.id === "mock:place:reciprocity-lab")).toBe(false);
    expect(sharedTags(["science", "activism"], new Set(["ecology", "adventure", "animation", "outdoors", "repair", "activism"])))
      .toEqual(["activism"]);
  });

  it("merges nothing when no candidate passes the gate (example 02, distance 1)", async () => {
    const result = await new DiscoveryAgent(new MockQlooClient(), noOneLiners).discover({ ...example02, distance: 1 });
    const bridge = result.trace.find((step) => step.stage === "bridge")?.detail ?? "";
    expect(bridge.split("\n")[0]).toMatch(
      /^Decision: Patagonia was cited by 0\/10 → fetched 5 candidates seeded with it; 0 passed the relevance gate \(shared tags ≥ 2 with your other interests; best: .*\); kept first query$/,
    );
    expect(result.bridge).toEqual({ input: "Patagonia", candidates: 5, passed: 0, merged: 0 });
    expect(result.recommendations.some((item) => item.bridgedFrom)).toBe(false);
    expect(result.recommendations).toHaveLength(10);
  });

  it("merges at most 3, keeps tags for reused ids, and ignores non-taste tags", async () => {
    const search = async (name: string): Promise<ResolvedEntity[]> =>
      [{ id: `id:${name}`, name, type: "movie", tags: name === "Lonely" ? ["solo"] : ["noir", "rain", "jazz", "18-24", "Audiobook"] }];
    let searches = 0;
    const fake: QlooClient = {
      mode: "mock",
      search: async (name) => { searches += 1; return search(name); },
      insights: async (query) => {
        if (query.signalEntityIds.length === 1) {
          return ["p1", "p2", "p3", "p4"].map((id, index) => ({
            id, name: id.toUpperCase(), type: "artist", description: "", affinitySourceIds: [query.signalEntityIds[0]!],
            affinitySourceNames: [], affinity: 0.9 - index / 10, tags: ["Noir", "Rain"],
          })).concat([{ id: "junk", name: "JUNK", type: "artist", description: "", affinitySourceIds: [], affinitySourceNames: [],
            affinity: 0.99, tags: ["18-24", "audiobook", "noir"] }]);
        }
        return Array.from({ length: 10 }, (_, index) => ({
          id: `r${index}`, name: `R${index}`, type: "artist", description: "", affinitySourceIds: ["id:Alpha", "id:Beta"],
          affinitySourceNames: [], affinity: index / 10,
        }));
      },
    };
    const agent = new DiscoveryAgent(fake, noOneLiners);
    const input = { interests: ["Alpha", "Beta", "Lonely"], targetType: "artist" as const, distance: 2 as const };
    const first = await agent.discover(input);
    expect(first.bridge).toEqual({ input: "Lonely", candidates: 5, passed: 4, merged: 3 });
    expect(first.recommendations.filter((item) => item.bridgedFrom).map((item) => item.id)).toEqual(["p1", "p2", "p3"]);
    // The three weakest first-query cards were replaced; JUNK only shares non-taste tags plus one real one.
    expect(first.recommendations.map((item) => item.id).slice(0, 7)).toEqual(["r3", "r4", "r5", "r6", "r7", "r8", "r9"]);
    // A re-run with reused ids (slider move) does no /search and still has the other inputs' tags from the cache.
    searches = 0;
    const again = await agent.discover({ ...input, interests: first.resolved.map(({ id, name, type }) => ({ id, name, type })) });
    expect(searches).toBe(0);
    expect(again.bridge?.merged).toBe(3);
  });

  it("drops the lowest-affinity cards but never an input's only citation", () => {
    const resolved: ResolvedEntity[] = [{ id: "a", name: "A", type: "movie", tags: [] }, { id: "b", name: "B", type: "book", tags: [] }];
    const card = (id: string, score: number, sources: string[]): QlooInsight =>
      ({ id, name: id, type: "artist", description: "", affinitySourceIds: sources, affinitySourceNames: [], score });
    const cards = [card("strong", 0.9, ["a"]), card("onlyB", 0.1, ["b"]), card("weakA", 0.2, ["a"]), card("midA", 0.5, ["a"])];
    expect([...pickCardsToDrop(cards, resolved, 2)]).toEqual(["weakA", "midA"]);
    // Asked for 4, only 2 are safe: "strong" is then A's last citation and "onlyB" is B's.
    expect([...pickCardsToDrop(cards, resolved, 4)]).toEqual(["weakA", "midA"]);
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
        { entity_id: "x", name: "Pic &amp; Co", properties: { image: { url: "http://images.qloo.com/x.jpg" } }, query: { affinity: 0.7 },
          tags: [{ id: "urn:tag:genre:music:ambient", name: "Ambient" }, { id: "urn:tag:keyword:qloo:noir", name: "Noir" }] },
        { entity_id: "y", name: "Elsewhere", properties: { image: { url: "https://evil.example/qloo.com/y.jpg" } } },
        { entity_id: "z", name: "Lookalike", properties: { image: { url: "https://images.qloo.com.evil.example/z.jpg" } } },
      ] } }), { status: 200 });
    });
    const client = new HttpQlooClient("test-key");
    const { matches } = await new DiscoveryAgent(client, noOneLiners).resolveMatches([{ name: "Left Hand", type: "book" }], true);
    expect(matches[0]?.entity).toMatchObject({ id: "b1", disambiguation: "1969" });
    expect(matches[0]?.alternatives?.map((entity) => [entity.id, entity.name, entity.type])).toEqual([
      ["b3", "Left Hand & Right", "book"],
      ["m1", "Left Hand", "movie"],
    ]);
    const [insight, other, lookalike] = await client.insights({ targetType: "artist", signalEntityIds: ["b1"], excludeEntityIds: [], take: 3, explainability: true });
    expect(insight).toMatchObject({ name: "Pic & Co", imageUrl: "https://images.qloo.com/x.jpg", affinity: 0.7, tags: ["Ambient", "Noir"] });
    // Only Qloo-hosted images survive.
    expect(other?.imageUrl).toBeUndefined();
    expect(lookalike?.imageUrl).toBeUndefined();
  });
});
