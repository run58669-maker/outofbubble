import { afterEach, describe, expect, it, vi } from "vitest";
import { DiscoveryAgent, PREFERRED_INPUT_TYPES } from "./agent.js";
import { HttpQlooClient } from "./http-qloo-client.js";
import { MockQlooClient } from "./mock-qloo-client.js";
import { nameScore } from "./name-match.js";
import type { InsightQuery, QlooClient } from "./types.js";

const baseInput = {
  interests: ["Blade Runner 2049", "The Left Hand of Darkness", "Disco Elysium"],
  targetType: "artist" as const,
  distance: 2 as const,
};

const noOneLiners = async () => new Map<string, string>();

describe("type-aware resolver", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("never lets a locality win an unhinted input (example 02)", async () => {
    const client = new MockQlooClient();
    const result = await new DiscoveryAgent(client, noOneLiners).discover({
      interests: ["Nausicaa", "Braiding Sweetgrass", "Patagonia"], targetType: "place", city: "Kyoto", distance: 2,
    });
    expect(result.resolved.map((entity) => [entity.name, entity.type])).toEqual([["Nausicaa", "movie"], ["Braiding Sweetgrass", "book"], ["Patagonia", "brand"]]);
    expect(client.searchLog[0]?.types).toEqual(PREFERRED_INPUT_TYPES);
  });

  it("uses only the explicit type hint (example 03: Hades the game, not the band)", async () => {
    const agent = new DiscoveryAgent(new MockQlooClient(), noOneLiners);
    const unhinted = await agent.resolve(["Hades"]);
    expect(unhinted[0]?.id).toBe("mock:decoy-hades-band");
    const result = await agent.discover({
      interests: [{ name: "Hades", type: "video_game" }, { name: "Hadestown", type: "place" }, { name: "Circe", type: "book" }],
      targetType: "podcast", distance: 2,
    });
    expect(result.matches.map((match) => match.entity?.id)).toEqual(["mock:hades", "mock:hadestown", "mock:circe"]);
  });

  it("falls back to an untyped search but keeps the place exclusion", async () => {
    const client = new MockQlooClient();
    const [match] = (await new DiscoveryAgent(client, noOneLiners).resolveMatches(["Hadestown"])).matches;
    expect(client.searchLog.map((entry) => entry.types)).toEqual([PREFERRED_INPUT_TYPES, undefined]);
    expect(match?.entity).toBeUndefined();
  });

  it("offers up to three alternatives for the picker", async () => {
    const { matches } = await new DiscoveryAgent(new MockQlooClient(), noOneLiners).resolveMatches(["Hades"], true);
    expect(matches[0]?.entity?.id).toBe("mock:decoy-hades-band");
    expect(matches[0]?.alternatives?.map((entity) => entity.id)).toEqual(["mock:hades"]);
  });

  it("uses a user-picked entity id without searching", async () => {
    const client = new MockQlooClient();
    const [entity] = await new DiscoveryAgent(client, noOneLiners).resolve([{ name: "Hades", type: "video_game", id: "mock:hades" }]);
    expect(entity).toMatchObject({ id: "mock:hades", type: "video_game" });
    expect(client.searchLog).toEqual([]);
  });

  it("counts containment only when the query sits inside the hit name", () => {
    expect(nameScore("Nausicaa", "Nausicaä of the Valley of the Wind")).toBe(0.9);
    expect(nameScore("Flimzap Nonexistent", "Nonexistent")).toBeLessThan(0.8);
    expect(nameScore("Zzyzx Nonexistent Book", "Book")).toBeLessThan(0.8);
  });

  it("sends the types filter and refuses to run when nothing real resolved", async () => {
    const urls: URL[] = [];
    vi.stubGlobal("fetch", async (url: string) => {
      const parsed = new URL(url);
      urls.push(parsed);
      const body = parsed.pathname === "/search"
        ? { results: [{ entity_id: "alb", name: "Nonexistent", types: ["urn:entity:artist"] }, { entity_id: "bk", name: "Book", types: ["urn:entity:brand"] }] }
        : { results: { entities: [] } };
      return new Response(JSON.stringify(body), { status: 200 });
    });
    const result = await new DiscoveryAgent(new HttpQlooClient("test-key"), noOneLiners).discover({
      ...baseInput,
      interests: ["Flimzap Nonexistent", "Zzyzx Nonexistent Book", "Qwrtzp Nonexistent"],
    });
    expect(urls[0]?.searchParams.get("types")).toBe(PREFERRED_INPUT_TYPES.map((type) => `urn:entity:${type}`).join(","));
    expect(result.resolved).toEqual([]);
    expect(result.recommendations).toEqual([]);
    expect(result.error).toMatch(/None/);
    expect(urls.some((url) => url.pathname === "/v2/insights")).toBe(false);
  });
});

describe("agent decision step", () => {
  it("raises the far-out cap once when too few results come back", async () => {
    const agent = new DiscoveryAgent(new MockQlooClient(), noOneLiners);
    const first = await agent.discover(baseInput);
    // Exclude 8 of the 12 mock artists under the 0.65 cap, so the first query returns only 4.
    const excludeIds = first.recommendations.slice(0, 8).map((item) => item.id);
    const result = await agent.discover({ ...baseInput, excludeIds });
    const decision = result.trace.find((step) => step.stage === "decide")?.detail ?? "";
    expect(result.trace.filter((step) => step.stage === "discover")).toHaveLength(2);
    expect(decision).toMatch(/^Decision: raised filter\.popularity\.max 0\.65 → 0\.8 and retried because only 4 results came back \(fewer than 6\); kept the retry \(6 results/);
    expect(result.recommendations).toHaveLength(6);
  });

  it("drops bias.trends once when most results are unexplained", async () => {
    const queries: InsightQuery[] = [];
    const fake: QlooClient = {
      mode: "mock",
      search: async (name) => [{ id: `id:${name}`, name, type: "movie", tags: [] }],
      insights: async (query) => {
        queries.push(query);
        const explained = query.biasTrends ? 2 : 9;
        return Array.from({ length: 10 }, (_, index) => ({
          id: `r${index}`, name: `R${index}`, type: "artist", description: "",
          affinitySourceIds: index < explained ? ["id:Alpha"] : [], affinitySourceNames: [],
        }));
      },
    };
    const result = await new DiscoveryAgent(fake, noOneLiners).discover({ ...baseInput, interests: ["Alpha", "Beta", "Gamma"] });
    expect(queries.map((query) => query.biasTrends)).toEqual(["low", undefined]);
    expect(result.trace.find((step) => step.stage === "decide")?.detail)
      .toBe("Decision: dropped bias.trends=low and retried because only 2/10 results were explained (under 50%); kept the retry (10 results, 9/10 explained)");
  });
});
