import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { InsightQuery, QlooClient, QlooInsight, ResolvedEntity } from "./types.js";

interface FixtureEntity extends ResolvedEntity {}
interface FixtureInsight {
  id: string;
  name: string;
  type: string;
  description: string;
  affinityTags: string[];
  popularity: number;
  trend: number;
}

function readFixture<T>(name: string): T {
  return JSON.parse(readFileSync(resolve(process.cwd(), "fixtures", name), "utf8")) as T;
}

function hash(value: string): number {
  return [...value].reduce((total, char) => (total * 31 + char.charCodeAt(0)) >>> 0, 7);
}

export class MockQlooClient implements QlooClient {
  readonly mode = "mock" as const;
  private readonly entities = readFixture<FixtureEntity[]>("entities.json");
  private readonly catalog = readFixture<FixtureInsight[]>("insights.json");

  async search(query: string): Promise<ResolvedEntity[]> {
    const normalized = query.trim().toLowerCase();
    const matches = this.entities.filter(
      (entity) => entity.name.toLowerCase() === normalized || entity.name.toLowerCase().includes(normalized),
    );
    return matches;
  }

  async insights(query: InsightQuery): Promise<QlooInsight[]> {
    const excluded = new Set(query.excludeEntityIds);
    const signals = this.entities.filter((entity) => query.signalEntityIds.includes(entity.id));
    const signalTags = new Set(signals.flatMap((entity) => entity.tags));
    const candidates = this.catalog
      .filter((item) => item.type === query.targetType)
      .filter((item) => query.popularityMin === undefined || item.popularity >= query.popularityMin)
      .filter((item) => query.popularityMax === undefined || item.popularity <= query.popularityMax)
      .filter((item) => !excluded.has(item.id))
      .map((item, originalIndex) => ({
        item,
        originalIndex,
        affinity: item.affinityTags.filter((tag) => signalTags.has(tag)).length,
      }));

    let ranked: typeof candidates;
    if (query.popularityMax !== undefined && query.popularityMin !== undefined) {
      const byPopularity = [...candidates].sort((a, b) => b.item.popularity - a.item.popularity || b.item.trend - a.item.trend);
      ranked = [];
      while (byPopularity.length) {
        const popular = byPopularity.shift();
        const obscure = byPopularity.pop();
        if (popular) ranked.push(popular);
        if (obscure) ranked.push(obscure);
      }
    } else if (query.popularityMax !== undefined) {
      ranked = [...candidates].sort((a, b) =>
        a.item.popularity - b.item.popularity || a.item.trend - b.item.trend || b.affinity - a.affinity || a.originalIndex - b.originalIndex);
    } else {
      ranked = [...candidates].sort((a, b) =>
        b.item.popularity - a.item.popularity || b.item.trend - a.item.trend || b.affinity - a.affinity || a.originalIndex - b.originalIndex);
    }
    ranked = ranked.slice(0, query.take);

    return ranked.map(({ item }) => {
      const sources = signals.filter((entity) => entity.tags.some((tag) => item.affinityTags.includes(tag)));
      const chosen = sources.slice(0, 2);
      return {
        id: item.id,
        name: item.name,
        type: item.type,
        description: item.description,
        affinitySourceIds: chosen.map((entity) => entity.id),
        affinitySourceNames: chosen.map((entity) => entity.name),
        score: 0.71 + (hash(item.id) % 20) / 100,
        popularity: item.popularity,
        trend: item.trend,
      };
    });
  }
}
