/**
 * "I already know this" ids survive slider moves, match switches and refills. They reset only on Start over or when
 * the set of inputs changes (added/removed; order and case do not matter, and switching an input's match keeps the
 * user's typed text, so it is not a change).
 */
export interface ExclusionState {
  key: string;
  ids: string[];
}

export function inputsKey(names: readonly string[]): string {
  return [...new Set(names.map((name) => name.trim().toLocaleLowerCase()))].sort().join("\u0000");
}

/** The exclusion list to send with a discovery run over `names`. */
export function carryExclusions(state: ExclusionState, names: readonly string[]): ExclusionState {
  const key = inputsKey(names);
  return key === state.key ? state : { key, ids: [] };
}

/** The server accepts at most this many excludeIds; the oldest known ids drop off first. */
export const MAX_EXCLUSIONS = 50;

/** Adds a known id (no duplicates, newest kept). */
export function addExclusion(state: ExclusionState, id: string): ExclusionState {
  return state.ids.includes(id) ? state : { ...state, ids: [...state.ids, id].slice(-MAX_EXCLUSIONS) };
}

export const NO_EXCLUSIONS: ExclusionState = { key: "", ids: [] };
