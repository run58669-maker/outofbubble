import { distanceProfile, obscurityBadge } from "./distance.js";
import { buildInsightsParams } from "./http-qloo-client.js";
import { normalizeName, rankMatches } from "./name-match.js";
import { InputError } from "./errors.js";
import { generateOneLiners } from "./one-liners.js";
import {
  ENTITY_TYPES,
  TARGET_TYPES,
  type DiscoverInput,
  type DiscoveryResult,
  type InsightQuery,
  type InterestInput,
  type InterestMatch,
  type QlooClient,
  type QlooInsight,
  type Recommendation,
  type ResolvedEntity,
  type TraceStep,
} from "./types.js";

export const DEFAULT_CARD_COUNT = 10;

/** Without an explicit hint, inputs are searched as these types first (Qloo /search `types`). */
export const PREFERRED_INPUT_TYPES = ["movie", "book", "video_game", "tv_show", "album", "artist", "podcast", "brand"] as const;
/** Place-like entities never win an unhinted input: "Patagonia" the brand, not the region. */
export const PLACE_INPUT_TYPES: ReadonlySet<string> = new Set(["locality", "place", "destination"]);
export const MAX_ALTERNATIVES = 3;
/** Looser name threshold for the picker's alternatives than for the automatic match. */
const ALTERNATIVE_MIN_SIMILARITY = 0.6;

/** Self-correction thresholds: fewer results than this, or less than half explained, triggers one relaxed retry. */
export const MIN_GOOD_RESULTS = 6;
export const MIN_EXPLAINED_SHARE = 0.5;
const POPULARITY_NOTCH = 0.15;
const POPULARITY_CEILING = 0.96;
/** Page size of the one extra taste-bridge query seeded with an uncited input alone: a candidate pool, not results. */
export const BRIDGE_TAKE = 8;
/** A bridge candidate must share at least this many Qloo tags with the union of the user's OTHER inputs. */
export const BRIDGE_MIN_SHARED_TAGS = 2;
/** At most this many bridge candidates replace first-query cards. */
export const BRIDGE_MAX_MERGE = 3;
/** Tags that say nothing about taste (formats, platforms, audience age brackets) never count as shared. */
const NON_TASTE_TAGS = new Set([
  "audiobook", "hardcover", "paperback", "print", "digital", "ebook", "kindle", "novels", "fiction", "nonfiction", "non fiction",
  "single player", "singleplayer", "multiplayer", "microsoft windows", "windows", "macos", "linux", "playstation 4", "playstation 5",
  "xbox one", "xbox series x s", "nintendo switch", "first person", "third person", "multiple persons", "english", "music", "podcast",
]);
const MAX_CACHED_TAG_SETS = 2000;

/** Lowercase, accent- and punctuation-free tag key; undefined for tags that carry no taste signal. */
export function tagKey(tag: string): string | undefined {
  const key = tag.normalize("NFKD").replace(/[\u0300-\u036f]/g, "").toLocaleLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
  if (!key || /^\d/.test(key) || NON_TASTE_TAGS.has(key)) return undefined;
  return key;
}

/** The candidate's tags (its own spelling, deduped by key) that also appear among `otherTags` keys. */
export function sharedTags(candidateTags: readonly string[] | undefined, otherTags: ReadonlySet<string>): string[] {
  const seen = new Set<string>();
  return (candidateTags ?? []).filter((tag) => {
    const key = tagKey(tag);
    if (!key || seen.has(key) || !otherTags.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function toInterest(value: string | InterestInput): InterestInput | undefined {
  if (typeof value === "string") return { name: value.trim() };
  if (typeof value !== "object" || value === null || typeof value.name !== "string") return undefined;
  const type = typeof value.type === "string" ? value.type.trim().toLowerCase() : "";
  const id = typeof value.id === "string" ? value.id.trim() : "";
  return {
    name: value.name.trim(),
    ...((ENTITY_TYPES as readonly string[]).includes(type) ? { type } : {}),
    ...(id && id.length <= 200 ? { id } : {}),
  };
}

/** Trim, drop empties, deduplicate by name (case-insensitive); keeps valid type hints and picked ids. */
export function normalizeInterests(interests: Array<string | InterestInput>): InterestInput[] {
  const seen = new Set<string>();
  return interests
    .map(toInterest)
    .filter((interest): interest is InterestInput => {
      if (!interest?.name) return false;
      const key = interest.name.toLocaleLowerCase();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
}

export function normalizeInterestNames(interests: Array<string | InterestInput>): string[] {
  return normalizeInterests(interests).map((interest) => interest.name);
}

export function validateDiscoverInput(input: DiscoverInput): Omit<DiscoverInput, "interests"> & { interests: InterestInput[] } {
  const interests = normalizeInterests(input.interests ?? []);
  if (interests.length < 3 || interests.length > 5) throw new InputError("Choose 3 to 5 interests.");
  if (!TARGET_TYPES.includes(input.targetType)) throw new InputError("Choose a supported target category.");
  if (![0, 1, 2].includes(input.distance)) throw new InputError("Distance must be 0, 1, or 2.");
  if (input.targetType === "place" && !input.city?.trim()) throw new InputError("Add a city for place discovery.");
  return { ...input, interests, city: input.city?.trim(), excludeIds: input.excludeIds ?? [] };
}

/** Every explainability source that maps to a resolved input, strongest score first (Qloo order breaks ties). */
export function buildExplanation(insight: QlooInsight, resolved: ResolvedEntity[]): { becauseOf: string[]; scores: Array<number | null>; text: string } {
  const byId = new Map(resolved.map((entity) => [entity.id, entity.name]));
  const resolvedNames = new Map(resolved.map((entity) => [entity.name.toLocaleLowerCase(), entity.name]));
  const scores = insight.affinitySourceScores ?? {};
  const found = new Map<string, number | null>();
  const add = (name: string | undefined, score: number | undefined) => {
    if (!name) return;
    const previous = found.get(name);
    if (previous === undefined) found.set(name, score ?? null);
    else if (score !== undefined && (previous === null || score > previous)) found.set(name, score);
  };
  insight.affinitySourceNames.forEach((name) => add(resolvedNames.get(name.toLocaleLowerCase()), scores[name]));
  insight.affinitySourceIds.forEach((id) => add(byId.get(id), scores[id]));
  const ordered = [...found].map(([name, score], index) => ({ name, score, index }))
    .sort((a, b) => (b.score ?? -Infinity) - (a.score ?? -Infinity) || a.index - b.index);
  return {
    becauseOf: ordered.map((entry) => entry.name),
    scores: ordered.map((entry) => entry.score),
    text: insight.description,
  };
}

/** One line per parameter actually sent to Qloo /v2/insights (same builder as HttpQlooClient). */
function formatInsightsQuery(query: InsightQuery): string {
  return [...buildInsightsParams(query)].map(([key, value]) => {
    const ids = value.split(",");
    return ids.length > 3 && key !== "signal.interests.entities" ? `${key}=<${ids.length} ids>` : `${key}=${value}`;
  }).join("\n");
}

interface RunQuality { count: number; explained: number }

function quality(insights: QlooInsight[], resolved: ResolvedEntity[]): RunQuality {
  return { count: insights.length, explained: insights.filter((insight) => buildExplanation(insight, resolved).becauseOf.length > 0).length };
}

function describe(run: RunQuality): string {
  return `${run.count} results, ${run.explained}/${run.count} explained`;
}

/** The one looser setting the agent may try, or undefined when nothing is left to relax. */
export function relaxQuery(query: InsightQuery, reason: "too-few" | "unexplained"): { query: InsightQuery; change: string } | undefined {
  const biasSent = query.biasTrends !== undefined && query.targetType !== "book";
  const raiseCap = () => {
    if (query.popularityMax === undefined || query.popularityMax >= POPULARITY_CEILING) return undefined;
    const popularityMax = Math.round(Math.min(query.popularityMax + POPULARITY_NOTCH, POPULARITY_CEILING) * 100) / 100;
    return { query: { ...query, popularityMax }, change: `raised filter.popularity.max ${query.popularityMax} → ${popularityMax}` };
  };
  const dropBias = () => biasSent
    ? { query: { ...query, biasTrends: undefined }, change: `dropped bias.trends=${query.biasTrends}` }
    : undefined;
  const dropMin = () => query.popularityMin !== undefined
    ? { query: { ...query, popularityMin: undefined }, change: `dropped filter.popularity.min=${query.popularityMin}` }
    : undefined;
  return reason === "too-few" ? raiseCap() ?? dropBias() ?? dropMin() : dropBias() ?? raiseCap();
}

/** Lexicographic: enough results, then enough explained, then more results, then more explained. */
function better(candidate: RunQuality, current: RunQuality, minResults: number): boolean {
  const key = (run: RunQuality) => [
    run.count >= minResults ? 1 : 0,
    run.count > 0 && run.explained / run.count >= MIN_EXPLAINED_SHARE ? 1 : 0,
    run.count,
    run.explained,
  ];
  const [a, b] = [key(candidate), key(current)];
  for (let index = 0; index < a.length; index += 1) if (a[index] !== b[index]) return a[index]! > b[index]!;
  return false;
}

/** How many cards cite each resolved input (by explainability), in input order. */
export function citationCounts(insights: QlooInsight[], resolved: ResolvedEntity[]): Array<{ entity: ResolvedEntity; count: number }> {
  const cited = insights.map((insight) => new Set(buildExplanation(insight, resolved).becauseOf));
  return resolved.map((entity) => ({ entity, count: cited.filter((names) => names.has(entity.name)).length }));
}

/** Lower affinity first; without an affinity, Qloo's own order decides (later = weaker). */
function affinityOf(insight: QlooInsight): number | undefined {
  return insight.affinity ?? insight.score;
}

/**
 * Picks up to `dropCount` cards from the first batch to make room for bridge cards: lowest affinity first, and a card
 * that is the only remaining citation of some input is never dropped (so fewer than `dropCount` may come back).
 */
export function pickCardsToDrop(insights: QlooInsight[], resolved: ResolvedEntity[], dropCount: number): Set<string> {
  const order = insights
    .map((insight, index) => ({ insight, index, affinity: affinityOf(insight) }))
    .sort((a, b) => (a.affinity ?? -Infinity) - (b.affinity ?? -Infinity) || b.index - a.index);
  const sources = new Map(insights.map((insight) => [insight.id, buildExplanation(insight, resolved).becauseOf]));
  const counts = new Map<string, number>();
  for (const names of sources.values()) for (const name of names) counts.set(name, (counts.get(name) ?? 0) + 1);
  const dropped = new Set<string>();
  const drop = (id: string) => {
    dropped.add(id);
    for (const name of sources.get(id) ?? []) counts.set(name, (counts.get(name) ?? 1) - 1);
  };
  for (const { insight } of order) {
    if (dropped.size >= dropCount) break;
    if ((sources.get(insight.id) ?? []).every((name) => (counts.get(name) ?? 0) > 1)) drop(insight.id);
  }
  return dropped;
}

interface BridgeOutcome {
  insights: QlooInsight[];
  detail: string;
  /** Present when the candidate query ran and returned (merged may be 0). */
  ran?: { input: string; candidates: number; passed: number; merged: number };
  bridgedIds: Set<string>;
  sharedById: Map<string, string[]>;
}

export class DiscoveryAgent {
  /** Qloo tags per entity id from earlier /search calls, so re-runs with reused ids still have tags for the bridge. */
  private readonly tagCache = new Map<string, string[]>();

  constructor(
    private readonly qloo: QlooClient,
    private readonly oneLiners: typeof generateOneLiners = generateOneLiners,
  ) {}

  private rememberTags(entities: ResolvedEntity[]) {
    for (const entity of entities) {
      if (!entity.tags.length) continue;
      this.tagCache.delete(entity.id);
      this.tagCache.set(entity.id, entity.tags);
      if (this.tagCache.size > MAX_CACHED_TAG_SETS) this.tagCache.delete(this.tagCache.keys().next().value!);
    }
  }

  /** Tags for a resolved input: its own, else cached, else one typed /search by name (only when the bridge needs it). */
  private async tagsOf(entity: ResolvedEntity): Promise<string[]> {
    if (entity.tags.length) return entity.tags;
    const cached = this.tagCache.get(entity.id);
    if (cached) return cached;
    try {
      const hits = await this.qloo.search(entity.name, entity.type !== "entity" ? [entity.type] : undefined);
      this.rememberTags(hits);
      return hits.find((hit) => hit.id === entity.id)?.tags ?? [];
    } catch {
      return [];
    }
  }

  get mode(): QlooClient["mode"] {
    return this.qloo.mode;
  }

  /**
   * Type-aware resolution. A hinted input searches only its type. An unhinted input searches the preferred
   * types and never accepts a place-like entity. If the typed search yields no name match, an untyped search
   * runs with the same name match and the same type rule.
   */
  private async resolveOne(interest: InterestInput, withAlternatives: boolean): Promise<{ match: InterestMatch; detail: string }> {
    const hint = interest.type;
    if (interest.id) {
      const entity: ResolvedEntity = { id: interest.id, name: interest.name, type: hint ?? "entity", tags: this.tagCache.get(interest.id) ?? [] };
      return { match: { interest: interest.name, entity }, detail: `${interest.name} → ${entity.type} · ${entity.id} (reused id, no search)` };
    }
    const allowed = (entity: ResolvedEntity) => (hint ? entity.type === hint : !PLACE_INPUT_TYPES.has(entity.type));
    let typedHits: ResolvedEntity[] = [];
    let typedRejected = "";
    try {
      typedHits = await this.qloo.search(interest.name, hint ? [hint] : PREFERRED_INPUT_TYPES);
    } catch (error) {
      // A rejected `types` filter (any 4xx) must never fail discovery: fall through to the untyped search.
      const status = (error as { status?: unknown }).status;
      if (typeof status !== "number" || status < 400 || status >= 500) throw error;
      // Keep a short excerpt of Qloo's own 400 text in the trace: it lists the allowed `types` values.
      const said = error instanceof Error ? error.message.replace(/^Qloo \/search failed \(\d+\): /, "").slice(0, 120) : "";
      typedRejected = ` (typed search rejected with ${status}; retried without types)${said ? ` · Qloo said: ${said}` : ""}`;
    }
    let ranked = rankMatches(interest.name, typedHits.filter(allowed));
    let route = hint ? `typed: ${hint}` : "typed";
    let untypedHits: ResolvedEntity[] = [];
    if (!ranked.length || withAlternatives) {
      untypedHits = await this.qloo.search(interest.name);
      if (!ranked.length) {
        ranked = rankMatches(interest.name, untypedHits.filter(allowed));
        route = "untyped fallback";
      }
    }
    this.rememberTags([...typedHits, ...untypedHits]);
    const entity = ranked[0];
    const match: InterestMatch = { interest: interest.name, entity };
    if (withAlternatives) {
      // Typed hits first; other entity types from the untyped search fill whatever room is left.
      // One entry per id and per name+type (the current match counts), so no row repeats the chip's own match.
      const key = (candidate: ResolvedEntity) => `${normalizeName(candidate.name)}|${candidate.type}`;
      const seen = new Set(entity ? [entity.id, key(entity)] : []);
      const fresh = (candidate: ResolvedEntity) => {
        if (seen.has(candidate.id) || seen.has(key(candidate))) return false;
        seen.add(candidate.id);
        seen.add(key(candidate));
        return true;
      };
      match.alternatives = [
        ...rankMatches(interest.name, typedHits, ALTERNATIVE_MIN_SIMILARITY),
        ...rankMatches(interest.name, untypedHits, ALTERNATIVE_MIN_SIMILARITY),
      ].filter(fresh).slice(0, MAX_ALTERNATIVES);
    }
    const detail = (entity
      ? `${interest.name} → ${entity.type} · ${entity.id} (${route})`
      : `${interest.name} → not found (no close name match)`) + typedRejected;
    return { match, detail };
  }

  async resolveMatches(interests: Array<string | InterestInput>, withAlternatives = false): Promise<{ matches: InterestMatch[]; detail: string }> {
    const unique = normalizeInterests(interests).slice(0, 5);
    const results = await Promise.all(unique.map((interest) => this.resolveOne(interest, withAlternatives)));
    const reused = unique.filter((interest) => interest.id).length;
    const plural = (count: number) => `${count} resolved id${count === 1 ? "" : "s"}`;
    const header = reused === unique.length
      ? `reused ${plural(reused)} (no /search call)`
      : `search.types=${PREFERRED_INPUT_TYPES.join(",")} (places only when hinted)${reused ? `; reused ${plural(reused)}` : ""}`;
    return { matches: results.map((result) => result.match), detail: [header, ...results.map((result) => result.detail)].join("\n") };
  }

  async resolve(interests: Array<string | InterestInput>): Promise<ResolvedEntity[]> {
    return (await this.resolveMatches(interests)).matches.flatMap((match) => (match.entity ? [match.entity] : []));
  }

  async discover(rawInput: DiscoverInput): Promise<DiscoveryResult> {
    const input = validateDiscoverInput(rawInput);
    const trace: TraceStep[] = [];
    const { matches, detail: resolveDetail } = await this.resolveMatches(input.interests);
    const resolved = matches.flatMap((match) => (match.entity ? [match.entity] : []));
    const unresolved = matches.filter((match) => !match.entity).map((match) => match.interest);
    trace.push({ stage: "resolve", title: "Resolve", detail: resolveDetail });

    if (resolved.length === 0) {
      trace.push({ stage: "decide", title: "Decide", detail: "Decision: did not query Qloo insights because no input matched a real entity" });
      return {
        recommendations: [],
        resolved,
        unresolved,
        matches,
        trace,
        mode: this.qloo.mode,
        error: "None of those inputs matched a real Qloo entity, so nothing was searched. Check the spelling or try a better-known title.",
      };
    }

    const profile = distanceProfile(input.distance);
    const firstQuery: InsightQuery = {
      targetType: input.targetType,
      signalEntityIds: resolved.map((entity) => entity.id),
      excludeEntityIds: input.excludeIds ?? [],
      take: Math.min(Math.max(input.limit ?? DEFAULT_CARD_COUNT, 1), DEFAULT_CARD_COUNT),
      city: input.city,
      biasTrends: profile.biasTrends,
      popularityMin: profile.popularityMin,
      popularityMax: profile.popularityMax,
      explainability: true,
    };
    // Defensive slice: never show more cards than requested, even if the API ignores the page size.
    const run = async (query: InsightQuery) => (await this.qloo.insights(query)).slice(0, query.take);
    let insights = await run(firstQuery);
    let usedQuery = firstQuery;
    let current = quality(insights, resolved);
    trace.push({ stage: "discover", title: "Discover", detail: `${formatInsightsQuery(firstQuery)}\nqloo.returned=${current.count}` });

    // Self-correction: one relaxed retry when the first page is thin or mostly unexplained.
    const minResults = Math.min(MIN_GOOD_RESULTS, firstQuery.take);
    const tooFew = current.count < minResults;
    const unexplained = !tooFew && current.explained / current.count < MIN_EXPLAINED_SHARE;
    let decision = `Decision: kept first query (${describe(current)})`;
    if (tooFew || unexplained) {
      const because = tooFew
        ? `only ${current.count} result${current.count === 1 ? "" : "s"} came back (fewer than ${minResults})`
        : `only ${current.explained}/${current.count} results were explained (under ${MIN_EXPLAINED_SHARE * 100}%)`;
      const relaxed = relaxQuery(firstQuery, tooFew ? "too-few" : "unexplained");
      if (!relaxed) {
        decision = `Decision: kept first query (${describe(current)}) because ${because} and no looser setting is left`;
      } else {
        const retried = await run(relaxed.query);
        const retryQuality = quality(retried, resolved);
        trace.push({ stage: "discover", title: "Discover (retry)", detail: `${formatInsightsQuery(relaxed.query)}\nqloo.returned=${retryQuality.count}` });
        const useRetry = better(retryQuality, current, minResults);
        decision = `Decision: ${relaxed.change} and retried because ${because}; kept the ${useRetry ? "retry" : "first query"} (${describe(useRetry ? retryQuality : current)})`;
        if (useRetry) {
          usedQuery = relaxed.query;
          insights = retried;
          current = retryQuality;
        }
      }
    }
    trace.push({ stage: "decide", title: "Decide", detail: decision });

    // Taste bridge: a full page (not a one-card refill) with 2+ inputs must cite every input at least once.
    const bridge = firstQuery.take >= MIN_GOOD_RESULTS && resolved.length > 1 && insights.length
      ? await this.tasteBridge(insights, resolved, usedQuery, run)
      : undefined;
    if (bridge) {
      insights = bridge.insights;
      trace.push({ stage: "bridge", title: "Taste bridge", detail: bridge.detail });
    }

    const oneLiners = await this.oneLiners(insights);
    const recommendations: Recommendation[] = insights.map((insight, index) => {
      const bridgedFrom = bridge?.bridgedIds.has(insight.id) ? bridge.ran?.input : undefined;
      // A bridge card was not cited by Qloo in the combined query: its only "because of" is the input the agent
      // seeded the extra query with, marked as seeded (bridgedFrom) and carrying no Qloo score.
      const explanation = bridgedFrom
        ? { becauseOf: [bridgedFrom], scores: [null], text: insight.description }
        : buildExplanation(insight, resolved);
      const sharedTagList = bridgedFrom ? bridge?.sharedById.get(insight.id) : undefined;
      return {
        id: insight.id,
        title: insight.name,
        type: input.targetType,
        becauseOf: explanation.becauseOf,
        becauseOfScores: explanation.scores,
        distance: input.distance,
        explanation: explanation.text,
        oneLiner: oneLiners.get(insight.id),
        artIndex: index % 10,
        explainabilityPresent: !bridgedFrom && explanation.becauseOf.length > 0,
        popularity: insight.popularity,
        badge: obscurityBadge(insight.popularity),
        ...(bridgedFrom ? { bridgedFrom } : {}),
        ...(sharedTagList?.length ? { sharedTags: sharedTagList } : {}),
        ...(insight.imageUrl ? { imageUrl: insight.imageUrl } : {}),
      };
    });
    trace.push({
      stage: "explain",
      title: "Explain",
      detail: `result.count=${recommendations.length}\nexplainability.present=${recommendations.filter((item) => item.explainabilityPresent).length}/${recommendations.length}`,
    });

    return {
      recommendations, resolved, unresolved, matches, trace, mode: this.qloo.mode,
      ...(bridge?.ran ? { bridgedInput: bridge.ran.input, bridge: bridge.ran } : {}),
    };
  }

  /**
   * The agent's taste decision. Count how many cards cite each input. If one input is cited by none, run ONE extra
   * /v2/insights call seeded with that input alone (same type and distance parameters, take=8) as a *candidate pool*.
   * A candidate is merged only if it shares >= BRIDGE_MIN_SHARED_TAGS Qloo tags with the union of the user's OTHER
   * inputs' tags (affinity, then popularity, break ties); at most BRIDGE_MAX_MERGE merge, each replacing the
   * lowest-affinity first-query card that is not some input's only citation. No passing candidate → nothing merges.
   */
  private async tasteBridge(
    insights: QlooInsight[],
    resolved: ResolvedEntity[],
    baseQuery: InsightQuery,
    run: (query: InsightQuery) => Promise<QlooInsight[]>,
  ): Promise<BridgeOutcome> {
    const counts = citationCounts(insights, resolved);
    const total = insights.length;
    const uncited = counts.filter((entry) => entry.count === 0);
    const target = uncited[0]?.entity;
    const none = { insights, bridgedIds: new Set<string>(), sharedById: new Map<string, string[]>() };
    if (!target) {
      const shares = counts.map((entry) => `${entry.entity.name} ${entry.count}`).join(" · ");
      return { ...none, detail: `Decision: every input is represented (${shares}); kept first query` };
    }
    const also = uncited.length > 1 ? ` (also uncited: ${uncited.slice(1).map((entry) => entry.entity.name).join(", ")}; one extra query only)` : "";
    const bridgeQuery: InsightQuery = {
      ...baseQuery,
      signalEntityIds: [target.id],
      excludeEntityIds: [...new Set([...baseQuery.excludeEntityIds, ...insights.map((insight) => insight.id)])],
      take: BRIDGE_TAKE,
    };
    const head = `Decision: ${target.name} was cited by 0/${total}`;
    let extra: QlooInsight[];
    try {
      extra = await run(bridgeQuery);
    } catch (error) {
      // The bridge is an improvement, never a reason to fail the whole page.
      const reason = error instanceof Error ? error.message.slice(0, 120) : "error";
      return { ...none, detail: `${head} → the candidate query failed (${reason}); kept first query${also}` };
    }
    const seen = new Set(insights.map((insight) => insight.id));
    const candidates = extra.filter((insight) => !seen.has(insight.id) && (seen.add(insight.id), true));

    // Relevance gate: shared tags with the union of the OTHER inputs' tags.
    const others = resolved.filter((entity) => entity.id !== target.id);
    const otherTags = new Set((await Promise.all(others.map((entity) => this.tagsOf(entity))))
      .flat().flatMap((tag) => tagKey(tag) ?? []));
    const scored = candidates
      .map((insight, index) => ({ insight, index, shared: sharedTags(insight.tags, otherTags) }))
      .sort((a, b) => b.shared.length - a.shared.length
        || (affinityOf(b.insight) ?? -Infinity) - (affinityOf(a.insight) ?? -Infinity)
        || (b.insight.popularity ?? -Infinity) - (a.insight.popularity ?? -Infinity)
        || a.index - b.index);
    const passed = scored.filter((entry) => entry.shared.length >= BRIDGE_MIN_SHARED_TAGS);
    const fetched = `→ fetched ${candidates.length} candidate${candidates.length === 1 ? "" : "s"} seeded with it`;
    const gate = `shared tags ≥ ${BRIDGE_MIN_SHARED_TAGS} with your other interests`;
    const quote = (entries: typeof scored) => entries.map((entry) => `"${entry.insight.name}" ${entry.shared.length}`).join(", ");
    const params = `\n${formatInsightsQuery(bridgeQuery)}\nqloo.returned=${extra.length}\nother inputs' tags=${otherTags.size}`;

    // Room: a short first page takes candidates without dropping anything; otherwise replace the weakest cards.
    const wanted = Math.min(passed.length, BRIDGE_MAX_MERGE);
    const room = Math.max(baseQuery.take - insights.length, 0);
    const dropped = pickCardsToDrop(insights, resolved, Math.max(wanted - room, 0));
    const merging = passed.slice(0, Math.min(wanted, room + dropped.size));
    const ran = { input: target.name, candidates: candidates.length, passed: passed.length, merged: merging.length };
    if (!merging.length) {
      const best = scored.slice(0, 2).filter((entry) => entry.shared.length > 0);
      const why = passed.length
        ? `${passed.length} passed the relevance gate (${gate}: ${quote(passed)}) but every first-query card is an input's only citation`
        : `0 passed the relevance gate (${gate}${best.length ? `; best: ${quote(best)}` : ""})`;
      return { ...none, ran, detail: `${head} ${fetched}; ${why}; kept first query${also}${params}` };
    }
    const tagLines = merging.map((entry) => `"${entry.insight.name}" shares: ${entry.shared.join(", ")}`).join("\n");
    return {
      insights: [...insights.filter((insight) => !dropped.has(insight.id)), ...merging.map((entry) => entry.insight)],
      ran,
      bridgedIds: new Set(merging.map((entry) => entry.insight.id)),
      sharedById: new Map(merging.map((entry) => [entry.insight.id, entry.shared])),
      detail: `${head} ${fetched}; ${passed.length} passed the relevance gate (${gate}: ${quote(passed)}); merged ${merging.length}, replaced ${dropped.size}${also}\n${tagLines}${params}`,
    };
  }

  async refill(rawInput: DiscoverInput, currentIds: string[], knownId: string): Promise<DiscoveryResult> {
    const excludeIds = [...new Set([...(rawInput.excludeIds ?? []), ...currentIds, knownId])];
    const result = await this.discover({ ...rawInput, excludeIds, limit: 1 });
    result.trace.push({
      stage: "refill",
      title: "Refill",
      detail: `filter.exclude.entities=<${excludeIds.length} ids>`,
    });
    return result;
  }
}
