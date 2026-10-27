import { describe, expect, it } from "vitest";
import { NO_EXCLUSIONS, addExclusion, carryExclusions } from "./exclusions.js";

describe("known-item exclusions", () => {
  const names = ["Blade Runner 2049", "The Left Hand of Darkness", "Disco Elysium"];

  it("persist across re-runs over the same inputs (slider move, match switch, refill)", () => {
    let state = carryExclusions(NO_EXCLUSIONS, names);
    state = addExclusion(state, "known-1");
    state = addExclusion(state, "known-2");
    state = addExclusion(state, "known-1");
    // Slider move / refill: same inputs. A match switch keeps the typed names too. Order and case do not matter.
    state = carryExclusions(state, names);
    state = carryExclusions(state, ["disco elysium", "Blade Runner 2049", "The Left Hand of Darkness"]);
    expect(state.ids).toEqual(["known-1", "known-2"]);
  });

  it("clear when the set of inputs changes, and on Start over", () => {
    const state = addExclusion(carryExclusions(NO_EXCLUSIONS, names), "known-1");
    expect(carryExclusions(state, [...names, "Hades"]).ids).toEqual([]);
    expect(carryExclusions(state, names.slice(1)).ids).toEqual([]);
    expect(carryExclusions(NO_EXCLUSIONS, names).ids).toEqual([]);
  });
});
