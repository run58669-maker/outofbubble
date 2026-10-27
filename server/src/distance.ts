import type { Distance, InsightQuery } from "./types.js";

export interface DistanceProfile {
  label: "Next door" | "Across town" | "Out of the bubble";
  biasTrends: NonNullable<InsightQuery["biasTrends"]>;
  popularityMin?: number;
  popularityMax?: number;
}

/** Far-out popularity cap. Below the "well known" badge floor, so a far-out card can never read "well known". */
export const FAR_OUT_POPULARITY_MAX = 0.65;

export function distanceProfile(distance: Distance): DistanceProfile {
  const profiles: Record<Distance, DistanceProfile> = {
    0: {
      label: "Next door",
      biasTrends: "high",
      popularityMin: 0.24,
    },
    1: {
      label: "Across town",
      biasTrends: "low",
      popularityMin: 0.08,
      popularityMax: 0.96,
    },
    2: {
      label: "Out of the bubble",
      biasTrends: "low",
      popularityMax: FAR_OUT_POPULARITY_MAX,
    },
  };
  return profiles[distance];
}

/** Card badge thresholds on Qloo popularity (0 to 1). The UI legend repeats these numbers. */
export const BADGE_THRESHOLDS = { wellKnown: 0.85, familiar: 0.6 } as const;

export type ObscurityBadge = "well known" | "familiar" | "deep cut" | "reach unknown";

export function obscurityBadge(popularity?: number): ObscurityBadge {
  if (popularity === undefined) return "reach unknown";
  if (popularity >= BADGE_THRESHOLDS.wellKnown) return "well known";
  if (popularity >= BADGE_THRESHOLDS.familiar) return "familiar";
  return "deep cut";
}
