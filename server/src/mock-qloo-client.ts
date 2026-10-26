import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { InsightQuery, QlooClient, QlooInsight, ResolvedEntity } from "./types.js";

interface FixtureEntity extends ResolvedEntity {}
interface FixtureInsight {
  id: string;
  name: string;
  description: string;
  affinityTags: string[];
}

function readFixture<T>(name: string): T {
  return JSON.parse(readFileSync(resolve(process.cwd(), "fixtures", name), "utf8")) as T;
}

function slug(value: string): string {
  return value
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "");
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
    if (matches.length > 0) return matches;

    return [
      {
        id: `mock:interest:${slug(query) || "unknown"}`,
        name: query.trim(),
        type: "interest",
        tags: ["cross-category", "curious"],
      },
    ];
  }

  async insights(query: InsightQuery): Promise<QlooInsight[]> {
    const excluded = new Set(query.excludeEntityIds);
    const signals = this.entities.filter((entity) => query.signalEntityIds.includes(entity.id));
    const signalTags = new Set(signals.flatMap((entity) => entity.tags));
    const seed = hash(`${query.signalEntityIds.join("|")}:${query.targetType}:${query.biasTrends}:${query.diversifyBy}`);

    const ranked = this.catalog
      .filter((item) => !excluded.has(item.id))
      .map((item, originalIndex) => ({
        item,
        originalIndex,
        affinity: item.affinityTags.filter((tag) => signalTags.has(tag)).length,
        wobble: hash(`${seed}:${item.id}`) % 17,
      }))
      .sort((a, b) => b.affinity - a.affinity || a.wobble - b.wobble || a.originalIndex - b.originalIndex)
      .slice(0, query.limit);

    return ranked.map(({ item }) => {
      const sources = signals.filter((entity) => entity.tags.some((tag) => item.affinityTags.includes(tag)));
      const chosen = (sources.length > 0 ? sources : signals).slice(0, 2);
      return {
        id: item.id,
        name: item.name,
        type: query.targetType,
        description: item.description,
        affinitySourceIds: chosen.map((entity) => entity.id),
        affinitySourceNames: chosen.map((entity) => entity.name),
        score: 0.71 + (hash(item.id) % 20) / 100,
      };
    });
  }
}
