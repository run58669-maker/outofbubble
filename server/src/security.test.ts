import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DiscoveryAgent } from "./agent.js";
import { DiscoverCache, discoverCacheKey } from "./discover-cache.js";
import { UpstreamError } from "./errors.js";
import { createApp, type AppOptions } from "./index.js";
import { MockQlooClient } from "./mock-qloo-client.js";
import { SlidingWindowLimiter } from "./rate-limit.js";
import type { QlooClient } from "./types.js";

const noOneLiners = async () => new Map<string, string>();
const demo = {
  interests: [{ name: "Blade Runner 2049", type: "movie" }, { name: "The Left Hand of Darkness", type: "book" }, { name: "Disco Elysium", type: "video_game" }],
  targetType: "artist",
  distance: 2,
};

let server: Server | undefined;
afterEach(() => {
  server?.close();
  server = undefined;
  vi.restoreAllMocks();
});

async function start(client: QlooClient = new MockQlooClient(), options: AppOptions = {}) {
  server = createApp(new DiscoveryAgent(client, noOneLiners), options).listen(0);
  await new Promise((resolve) => server!.once("listening", resolve));
  const base = `http://127.0.0.1:${(server!.address() as AddressInfo).port}`;
  return (path: string, body?: unknown, raw?: string) => fetch(`${base}${path}`, body === undefined && raw === undefined
    ? {}
    : { method: "POST", headers: { "Content-Type": "application/json" }, body: raw ?? JSON.stringify(body) });
}

describe("sliding-window rate limiter", () => {
  it("allows max hits per window per key, then frees up as hits age out", () => {
    let now = 0;
    const limiter = new SlidingWindowLimiter({ max: 3, windowMs: 60_000, now: () => now });
    expect([1, 2, 3].map(() => limiter.hit("a").allowed)).toEqual([true, true, true]);
    expect(limiter.hit("a")).toEqual({ allowed: false, retryAfterSeconds: 60 });
    expect(limiter.hit("b").allowed).toBe(true);
    now = 60_001;
    expect(limiter.hit("a").allowed).toBe(true);
  });

  it("answers 429 with a short JSON message on /api, but never limits /api/health", async () => {
    const call = await start(undefined, { rateLimit: { max: 2, windowMs: 60_000 } });
    expect((await call("/api/resolve", { interests: ["Disco Elysium"] })).status).toBe(200);
    expect((await call("/api/resolve", { interests: ["Disco Elysium"] })).status).toBe(200);
    const limited = await call("/api/resolve", { interests: ["Disco Elysium"] });
    expect(limited.status).toBe(429);
    expect(limited.headers.get("retry-after")).toBeTruthy();
    expect((await limited.json()).error).toMatch(/^Too many requests/);
    for (let index = 0; index < 4; index += 1) expect((await call("/api/health")).status).toBe(200);
  });
});

describe("route-layer input caps", () => {
  it("rejects oversized or malformed input with 400 (and 413 for a huge body)", async () => {
    const call = await start(undefined, { rateLimit: { max: 1000, windowMs: 60_000 } });
    const expect400 = async (body: unknown, message: RegExp) => {
      const response = await call("/api/discover", body);
      expect(response.status).toBe(400);
      expect((await response.json()).error).toMatch(message);
    };
    await expect400({ ...demo, interests: Array.from({ length: 11 }, (_, index) => `i${index}`) }, /At most 10 interests/);
    await expect400({ ...demo, interests: ["x".repeat(101), "b", "c"] }, /at most 100 characters/);
    await expect400({ ...demo, interests: [{ name: "a", type: "spaceship" }, "b", "c"] }, /Unknown interest type/);
    await expect400({ ...demo, interests: [{ name: "a", id: "i".repeat(65) }, "b", "c"] }, /at most 64 characters/);
    await expect400({ ...demo, city: "c".repeat(101) }, /City must be at most 100/);
    await expect400({ ...demo, excludeIds: Array.from({ length: 51 }, (_, index) => `e${index}`) }, /At most 50 excludeIds/);
    await expect400({ ...demo, excludeIds: ["e".repeat(65)] }, /at most 64 characters/);
    await expect400({ ...demo, interests: ["only one"] }, /Choose 3 to 5 interests/);
    const refill = await call("/api/exclude", { ...demo, knownId: "k", currentIds: Array.from({ length: 51 }, (_, index) => `c${index}`) });
    expect(refill.status).toBe(400);
    const huge = await call("/api/discover", undefined, JSON.stringify({ ...demo, pad: "x".repeat(40_000) }));
    expect(huge.status).toBe(413);
    const ok = await call("/api/discover", demo);
    expect(ok.status).toBe(200);
    expect(ok.headers.get("cache-control")).toBe("no-store");
  });
});

describe("upstream failures and the discover cache", () => {
  it("sends Qloo 429/5xx as 503 and other failures as a generic message (detail only in the log)", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    let failure: Error = new UpstreamError("Qloo is rate-limiting us, try again in a minute", 503);
    const client: QlooClient = { mode: "http", search: async () => { throw failure; }, insights: async () => [] };
    const call = await start(client, { rateLimit: { max: 1000, windowMs: 60_000 } });
    const busy = await call("/api/resolve", { interests: ["x"] });
    expect(busy.status).toBe(503);
    expect(await busy.json()).toEqual({ error: "Qloo is rate-limiting us, try again in a minute" });
    failure = new Error("secret internals at /srv/app");
    const broken = await call("/api/resolve", { interests: ["x"] });
    expect(broken.status).toBe(500);
    expect(JSON.stringify(await broken.json())).not.toContain("secret");
    expect(log).toHaveBeenCalled();
  });

  it("serves a repeated /api/discover from cache (same request in any order) and says so in the trace", async () => {
    const client = new MockQlooClient();
    const insights = vi.spyOn(client, "insights");
    const call = await start(client, { rateLimit: { max: 1000, windowMs: 60_000 } });
    const first = await (await call("/api/discover", demo)).json();
    const calls = insights.mock.calls.length;
    const again = await (await call("/api/discover", { ...demo, interests: [...demo.interests].reverse() })).json();
    expect(insights.mock.calls.length).toBe(calls);
    expect(again.trace[0]).toMatchObject({ stage: "cache", detail: expect.stringMatching(/^cache hit/) });
    expect(again.recommendations).toEqual(first.recommendations);
    // A different exclusion list is a different request.
    await call("/api/discover", { ...demo, excludeIds: [first.recommendations[0].id] });
    expect(insights.mock.calls.length).toBeGreaterThan(calls);
  });

  it("expires entries after the TTL and keeps at most max entries", () => {
    let now = 0;
    const cache = new DiscoverCache(1_000, 2, () => now);
    const result = { recommendations: [], resolved: [], unresolved: [], matches: [], trace: [], mode: "mock" as const };
    const key = (distance: 0 | 1 | 2) => discoverCacheKey({ interests: ["a", "b", "c"], targetType: "artist", distance });
    cache.set(key(0), result);
    cache.set(key(1), result);
    cache.set(key(2), result);
    expect(cache.size).toBe(2);
    expect(cache.get(key(0))).toBeUndefined();
    expect(cache.get(key(2))).toBeDefined();
    now = 1_001;
    expect(cache.get(key(2))).toBeUndefined();
  });
});
