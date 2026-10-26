import type { Distance, InsightQuery } from "./types.js";

export interface DistanceProfile {
  label: "Next door" | "Across town" | "Out of the bubble";
  biasTrends: InsightQuery["biasTrends"];
  diversifyBy: InsightQuery["diversifyBy"];
  popularityMin?: number;
  popularityMax?: number;
}

export function distanceProfile(distance: Distance): DistanceProfile {
  const profiles: Record<Distance, DistanceProfile> = {
    0: {
      label: "Next door",
      biasTrends: "high",
      diversifyBy: "entities",
      popularityMin: 0.55,
    },
    1: {
      label: "Across town",
      biasTrends: "low",
      diversifyBy: "tags",
      popularityMin: 0.2,
    },
    2: {
      label: "Out of the bubble",
      biasTrends: "low",
      diversifyBy: "tags",
      popularityMax: 0.45,
    },
  };
  return profiles[distance];
}
