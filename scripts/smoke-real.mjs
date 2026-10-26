import { DiscoveryAgent } from "../dist/server/agent.js";
import { HttpQlooClient } from "../dist/server/http-qloo-client.js";

const apiKey = process.env.QLOO_API_KEY;
if (!apiKey) {
  console.error("QLOO_API_KEY must be set before running the real Qloo smoke test.");
  process.exit(1);
}

const sets = [
  {
    name: "movie + book + game → artist",
    interests: ["Blade Runner 2049", "The Left Hand of Darkness", "Disco Elysium"],
    targetType: "artist",
    distance: 2,
  },
  {
    name: "artists → book",
    interests: ["Björk", "Fela Kuti", "Ryuichi Sakamoto"],
    targetType: "book",
    distance: 1,
  },
  {
    name: "podcasts → place in Tokyo",
    interests: ["Radiolab", "99% Invisible", "Song Exploder"],
    targetType: "place",
    city: "Tokyo",
    distance: 2,
  },
  {
    name: "brands → movie",
    interests: ["Patagonia", "Muji", "Nintendo"],
    targetType: "movie",
    distance: 1,
  },
  {
    name: "tv shows → podcast",
    interests: ["Severance", "Atlanta", "Dark"],
    targetType: "podcast",
    distance: 2,
  },
];

const noOneLiners = async () => new Map();
const agent = new DiscoveryAgent(new HttpQlooClient(apiKey), noOneLiners);
const rows = [];
let failed = false;

for (const set of sets) {
  try {
    const result = await agent.discover(set);
    const cards = result.recommendations.length;
    rows.push({
      set: set.name,
      "inputs resolved?": `${result.resolved.length}/${set.interests.length}`,
      cards,
      "first 3 titles": result.recommendations.slice(0, 3).map((item) => item.title).join(" | ") || "—",
      "explainability present?": cards > 0 && result.recommendations.every((item) => item.explainabilityPresent) ? "yes" : "no",
    });
    if (cards === 0) failed = true;
  } catch (error) {
    failed = true;
    rows.push({
      set: set.name,
      "inputs resolved?": "no",
      cards: 0,
      "first 3 titles": "—",
      "explainability present?": "no",
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

console.table(rows);
if (failed) process.exitCode = 1;
