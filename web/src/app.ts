import {
  HEALTH_POLL_INTERVAL_MS,
  HEALTH_POLL_TIMEOUT_MS,
  REQUEST_TIMEOUT_MS,
  WAKE_NOTICE_DELAY_MS,
  requestUiState,
  type RequestUiState,
} from "./request-policy.js";
import { NO_EXCLUSIONS, addExclusion, carryExclusions, type ExclusionState } from "./exclusions.js";
import { openInLinks } from "./open-in.js";

type TargetType = "artist" | "book" | "podcast" | "movie" | "tv_show" | "video_game" | "place";
type Distance = 0 | 1 | 2;
type Recommendation = { id: string; title: string; type: TargetType; becauseOf: string[]; becauseOfScores?: Array<number | null>; distance: Distance; explanation: string; oneLiner?: string; artIndex: number; explainabilityPresent: boolean; popularity?: number; badge?: string; bridgedFrom?: string; sharedTags?: string[]; imageUrl?: string };
type TraceStep = { stage: string; title: string; detail: string };
type Entity = { id: string; name: string; type: string; disambiguation?: string };
type Match = { interest: string; entity?: Entity; alternatives?: Entity[] };
type BridgeSummary = { input: string; candidates: number; passed: number; merged: number };
type DiscoveryResponse = { recommendations: Recommendation[]; trace: TraceStep[]; mode: "mock" | "http"; unresolved: string[]; matches?: Match[]; resolved?: Entity[]; bridgedInput?: string; bridge?: BridgeSummary; error?: string };
/** One input: `type` is an explicit hint, `id` a match the user picked from the type-chip picker. */
type Interest = { name: string; type?: string; id?: string };

const examples: Array<{ label: string; short: string; interests: Interest[]; targetType: TargetType; city?: string }> = [
  { label: "Blade Runner 2049 + The Left Hand of Darkness + Disco Elysium → artists", short: "Blade Runner 2049 + Left Hand of Darkness + Disco Elysium → artists", interests: [{ name: "Blade Runner 2049", type: "movie" }, { name: "The Left Hand of Darkness", type: "book" }, { name: "Disco Elysium", type: "video_game" }], targetType: "artist" },
  { label: "Nausicaa (film) + Braiding Sweetgrass (book) + Patagonia (brand) → places in Kyoto", short: "Nausicaa + Braiding Sweetgrass + Patagonia → Kyoto", interests: [{ name: "Nausicaa", type: "movie" }, { name: "Braiding Sweetgrass", type: "book" }, { name: "Patagonia", type: "brand" }], targetType: "place", city: "Kyoto" },
  { label: "Hades (game) + Hadestown (Broadway show) + Circe (book) → podcasts", short: "Hades + Hadestown + Circe → podcasts", interests: [{ name: "Hades", type: "video_game" }, { name: "Hadestown", type: "place" }, { name: "Circe", type: "book" }], targetType: "podcast" },
];

const distanceLabels = ["Next door", "Across town", "Out of the bubble"];
let interests: Interest[] = examples[0].interests.map((item) => ({ ...item }));
let recommendations: Recommendation[] = [];
/** "I already know this" ids: kept across slider moves, match switches and refills (see exclusions.ts). */
let exclusions: ExclusionState = NO_EXCLUSIONS;
/** The full trace of the last discovery run; refills are appended below it, never replace it. */
let baseTrace: TraceStep[] = [];
let refillTraces: Array<{ label: string; steps: TraceStep[] }> = [];
/** Resolved input names (Qloo's spelling) for the taste-bridge bar, and the input that needed the extra query. */
let resolvedNames: string[] = [];
let bridgedInput: string | undefined;
let bridgeSummary: BridgeSummary | undefined;
let unresolvedNames = new Set<string>();
/** Last resolution per input name (lowercase), from /api/discover or the picker. */
let matchByName = new Map<string, Match>();
let openPickerIndex: number | undefined;

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const tokens = $("interest-tokens");
const interestInput = $<HTMLInputElement>("interest-input");
const interestBox = $("interest-box");
const count = $("interest-count");
const target = $<HTMLSelectElement>("target-type");
const distance = $<HTMLInputElement>("distance");
const distanceValue = $("distance-value");
const cityField = $("city-field");
const cityInput = $<HTMLInputElement>("city-input");
const discoverButton = $<HTMLButtonElement>("discover-button");
const grid = $("card-grid");
const results = $("results");
const empty = $("empty-state");
const toast = $("toast");
const requestStatus = $("request-status");
const requestStatusCopy = $("request-status-copy");
const requestRetry = $<HTMLButtonElement>("request-retry");
const demoPill = $<HTMLButtonElement>("demo-pill");
let activeRequestId = 0;

class RequestTimeoutError extends Error {
  constructor() {
    super("The request timed out while the server was waking up.");
    this.name = "RequestTimeoutError";
  }
}

/**
 * Qloo busy or slow (server answered 503/504) or our own per-IP limit (429): the request-status bar shows the server's
 * message with the Retry button. Subclasses the timeout error so callers restore the cards without a toast.
 */
class RetryableRequestError extends RequestTimeoutError {
  constructor(message: string) {
    super();
    this.message = message;
    this.name = "RetryableRequestError";
  }
}

function showToast(message: string) {
  toast.textContent = message;
  toast.classList.add("visible");
  window.setTimeout(() => toast.classList.remove("visible"), 2600);
}

function hideRequestStatus() {
  requestStatus.hidden = true;
  requestStatus.classList.remove("timed-out", "awake", "error");
  requestRetry.hidden = true;
  requestRetry.onclick = null;
}

function showRequestError(message: string) {
  requestStatus.hidden = false;
  requestStatus.classList.remove("timed-out", "awake");
  requestStatus.classList.add("error");
  requestStatusCopy.textContent = message;
  requestRetry.hidden = true;
}

function setModeBadge(mode: "mock" | "http") {
  const badge = $("mode-note");
  badge.className = `mode-note ${mode}`;
  badge.textContent = mode === "mock" ? "Sample data — real Qloo key pending" : "Live Qloo";
}

function showRequestStatus(state: RequestUiState, retry?: () => void) {
  requestStatus.hidden = false;
  requestStatus.classList.toggle("timed-out", state.phase === "timed-out");
  requestStatus.classList.remove("awake");
  requestStatusCopy.textContent = state.message;
  requestRetry.hidden = !state.canRetry;
  requestRetry.onclick = state.canRetry && retry
    ? () => {
        hideRequestStatus();
        retry();
      }
    : null;
}

function showServerAwake(requestId: number) {
  if (requestId !== activeRequestId || requestStatus.classList.contains("timed-out")) return;
  requestStatus.hidden = false;
  requestStatus.classList.add("awake");
  requestStatusCopy.textContent = "Server is awake — finishing your request…";
}

function typeText(type: string) {
  return type.replace("_", " ");
}

function renderInterests() {
  // Re-rendering replaces the chips: drop any open picker and keep keyboard focus on the same chip.
  const focusedChip = [...tokens.querySelectorAll(".token-type")].indexOf(document.activeElement as Element);
  if (pickerPanel) closePicker();
  tokens.replaceChildren();
  interests.forEach((interest, index) => {
    const key = interest.name.toLocaleLowerCase();
    const match = matchByName.get(key);
    const unresolved = unresolvedNames.has(key);
    const token = document.createElement("span");
    token.className = "interest-token";
    const label = document.createElement("span");
    label.className = "token-label";
    label.textContent = interest.name;
    if (unresolved) {
      token.classList.add("unresolved");
      label.title = "Not found";
    } else if (match?.entity && match.entity.name !== interest.name) {
      label.title = `Matched: ${match.entity.name}`;
    }
    token.append(label);

    const shownType = match?.entity?.type ?? interest.type;
    const chip = document.createElement("button");
    chip.type = "button";
    chip.className = "token-type";
    const typeWord = unresolved ? "no match" : shownType ? typeText(shownType) : "auto";
    // The user's typed text stays on the token; when Qloo matched a different name, the chip shows it: typed → matched · type.
    const matchedName = !unresolved && match?.entity && match.entity.name.trim().toLocaleLowerCase() !== interest.name.trim().toLocaleLowerCase()
      ? match.entity.name : undefined;
    if (matchedName) {
      const name = document.createElement("span");
      name.className = "token-match";
      name.textContent = `→ ${matchedName}`;
      chip.append(name, document.createTextNode(` · ${typeWord}`));
      chip.title = `${interest.name} → ${matchedName} · ${typeWord}`;
    } else {
      chip.textContent = typeWord;
    }
    chip.setAttribute("aria-haspopup", "true");
    chip.setAttribute("aria-expanded", String(openPickerIndex === index));
    chip.setAttribute("aria-label", `${interest.name}: ${unresolved ? "no match" : `matched as ${matchedName ? `${matchedName}, ` : ""}${typeWord}`}. Show other matches`);
    chip.addEventListener("click", () => (openPickerIndex === index ? closePicker(true) : void openPicker(index, token, chip)));
    token.append(chip);

    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "token-remove";
    remove.setAttribute("aria-label", `Remove ${interest.name}`);
    remove.textContent = "×";
    remove.addEventListener("click", () => {
      closePicker();
      interests.splice(index, 1);
      unresolvedNames.clear();
      renderInterests();
      if (interests.length === 0) showEmpty();
    });
    token.append(remove);
    tokens.append(token);
  });
  if (focusedChip >= 0) chipAt(Math.min(focusedChip, interests.length - 1))?.focus();
  count.textContent = `${interests.length} of 5`;
  interestInput.hidden = interests.length >= 5;
  interestBox.classList.toggle("invalid", interests.length > 0 && interests.length < 3);
}

function addInterest() {
  const value = interestInput.value.trim();
  if (!value || interests.length >= 5) return;
  if (interests.some((item) => item.name.toLowerCase() === value.toLowerCase())) {
    showToast("That one is already in your mix.");
    return;
  }
  interests.push({ name: value });
  unresolvedNames.clear();
  interestInput.value = "";
  renderInterests();
}

function applyMatches(response: DiscoveryResponse) {
  const matches = response.matches ?? [];
  // Matches come back in input order. A re-run sends Qloo's own name for a reused id, so key by the user's input
  // (same position) rather than by the name the server echoes back.
  const sameShape = matches.length === interests.length;
  const keyFor = (match: Match, index: number) => (sameShape ? interests[index]!.name : match.interest).toLocaleLowerCase();
  unresolvedNames = new Set(matches.flatMap((match, index) => (match.entity ? [] : [keyFor(match, index)])));
  for (const name of response.unresolved) if (!sameShape) unresolvedNames.add(name.toLocaleLowerCase());
  matchByName = new Map(matches.map((match, index) => [keyFor(match, index), match]));
  renderInterests();
}

/* ---------- Type-chip picker: top 3 other Qloo matches for one input ---------- */

let pickerPanel: HTMLElement | undefined;
let pickerChip: HTMLButtonElement | undefined;

function closePicker(returnFocus = false) {
  const chip = pickerChip;
  pickerPanel?.remove();
  pickerPanel = undefined;
  pickerChip = undefined;
  openPickerIndex = undefined;
  chip?.setAttribute("aria-expanded", "false");
  if (returnFocus) chip?.focus();
}

function chipAt(index: number) {
  return tokens.children[index]?.querySelector<HTMLButtonElement>(".token-type") ?? undefined;
}

function pickMatch(index: number, entity: Entity) {
  // Keep what the user typed; only the match (id + type) changes. The chip shows "typed → matched · type".
  const typed = interests[index]!.name;
  interests[index] = { name: typed, type: entity.type, id: entity.id };
  const key = typed.toLocaleLowerCase();
  matchByName.set(key, { interest: typed, entity });
  unresolvedNames.delete(key);
  closePicker();
  renderInterests();
  chipAt(index)?.focus();
  showToast(`Now using ${entity.name} (${typeText(entity.type)}).`);
  if (!results.hidden && recommendations.length) void discover(false, true);
}

async function openPicker(index: number, token: HTMLElement, chip: HTMLButtonElement) {
  closePicker();
  const interest = interests[index];
  if (!interest) return;
  openPickerIndex = index;
  pickerChip = chip;
  chip.setAttribute("aria-expanded", "true");
  const panel = document.createElement("div");
  panel.className = "match-picker";
  panel.setAttribute("role", "group");
  panel.setAttribute("aria-label", `Other matches for ${interest.name}`);
  const status = document.createElement("p");
  status.textContent = "Looking up other matches…";
  panel.append(status);
  panel.addEventListener("keydown", (event) => {
    const options = [...panel.querySelectorAll<HTMLButtonElement>("button")];
    const at = options.indexOf(document.activeElement as HTMLButtonElement);
    if (event.key === "Escape") { event.preventDefault(); closePicker(true); }
    else if (event.key === "ArrowDown" && options.length) { event.preventDefault(); options[(at + 1) % options.length]?.focus(); }
    else if (event.key === "ArrowUp" && options.length) { event.preventDefault(); options[(at - 1 + options.length) % options.length]?.focus(); }
  });
  token.append(panel);
  pickerPanel = panel;
  try {
    const response = await fetch("/api/resolve", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      // The hint keeps the typed search on the input's own type; the server fills spare rows with other types.
      body: JSON.stringify({ interests: [{ name: interest.name, ...(interest.type ? { type: interest.type } : {}) }], alternatives: true }),
    });
    const payload = await response.json() as { matches?: Match[]; error?: string };
    if (pickerPanel !== panel) return;
    if (!response.ok) throw new Error(payload.error ?? "lookup failed");
    const found = payload.matches?.[0];
    const current = matchByName.get(interest.name.toLocaleLowerCase())?.entity;
    const nameKey = (entity: Entity) => `${entity.name.toLocaleLowerCase()}|${entity.type}`;
    // One row per id and per name+type; the input's current match is never offered again.
    const seen = new Set<string>([...(current ? [current.id, nameKey(current)] : []), ...(interest.id ? [interest.id] : [])]);
    const options = [found?.entity, ...(found?.alternatives ?? [])]
      .filter((entity): entity is Entity => {
        if (!entity || seen.has(entity.id) || seen.has(nameKey(entity))) return false;
        seen.add(entity.id);
        seen.add(nameKey(entity));
        return true;
      })
      .slice(0, 3);
    status.textContent = options.length ? "Switch this input to:" : "No other close matches in Qloo.";
    panel.append(...options.map((entity) => {
      const option = document.createElement("button");
      option.type = "button";
      option.append(document.createTextNode(entity.name));
      const kind = document.createElement("span");
      kind.textContent = ` · ${typeText(entity.type)}${entity.disambiguation ? ` · ${entity.disambiguation}` : ""}`;
      option.append(kind);
      option.addEventListener("click", () => pickMatch(index, entity));
      return option;
    }));
    (panel.querySelector("button") ?? chip).focus();
  } catch (error) {
    if (pickerPanel === panel) status.textContent = error instanceof Error && error.message !== "lookup failed" ? error.message : "Could not load other matches.";
  }
}

document.addEventListener("click", (event) => {
  const clicked = event.target as Node;
  if (pickerPanel && !pickerPanel.contains(clicked) && !pickerChip?.contains(clicked)) closePicker();
});

function showEmpty() {
  results.hidden = true;
  $("trace-panel").hidden = true;
  empty.hidden = false;
  demoPill.hidden = true;
}

function setLoading(loading: boolean) {
  discoverButton.disabled = loading;
  discoverButton.classList.toggle("loading", loading);
  grid.setAttribute("aria-busy", String(loading));
  if (loading) {
    grid.replaceChildren(...Array.from({ length: 6 }, () => {
      const item = document.createElement("div");
      item.className = "card-skeleton";
      return item;
    }));
    $("result-summary").textContent = "Tracing cross-category affinities…";
  }
}

/**
 * With `reuseIds`, every input that already resolved goes back as `{ id, name, type }` so the server skips /search
 * (refills, slider re-runs, picker switches). A fresh "Break the bubble" press resolves again, except picked ids.
 */
function currentInput(reuseIds = false) {
  return {
    interests: interests.map((interest) => {
      const entity = matchByName.get(interest.name.toLocaleLowerCase())?.entity;
      if (reuseIds && entity) return { id: entity.id, name: entity.name, type: entity.type };
      // A picked match goes back under Qloo's name for it; the typed text stays on the token.
      if (interest.id) return { id: interest.id, name: entity?.id === interest.id ? entity.name : interest.name, ...(interest.type ? { type: interest.type } : {}) };
      return interest;
    }),
    targetType: target.value as TargetType,
    distance: Number(distance.value) as Distance,
    city: target.value === "place" ? cityInput.value.trim() : undefined,
    excludeIds: exclusions.ids,
  };
}

async function api<T>(path: string, body: object, retry: () => void): Promise<T> {
  const requestId = ++activeRequestId;
  const controller = new AbortController();
  let healthController: AbortController | undefined;
  let healthPollTimer: number | undefined;
  let pollingStopped = false;
  let timedOut = false;
  let keepStatus = false;
  hideRequestStatus();

  const pollHealth = async () => {
    if (pollingStopped || requestId !== activeRequestId) return;
    healthController = new AbortController();
    const healthTimeout = window.setTimeout(() => healthController?.abort(), HEALTH_POLL_TIMEOUT_MS);
    try {
      const response = await fetch("/api/health", { cache: "no-store", signal: healthController.signal });
      const health = response.ok ? await response.json() as { ok?: boolean; mode?: "mock" | "http" } : undefined;
      if (health?.mode) setModeBadge(health.mode);
      if (health?.ok) showServerAwake(requestId);
    } catch {
      // The server may still be asleep. The next bounded poll will try again.
    } finally {
      window.clearTimeout(healthTimeout);
      if (!pollingStopped && requestId === activeRequestId) {
        healthPollTimer = window.setTimeout(() => void pollHealth(), HEALTH_POLL_INTERVAL_MS);
      }
    }
  };

  const wakeTimer = window.setTimeout(() => {
    if (requestId !== activeRequestId) return;
    showRequestStatus(requestUiState(WAKE_NOTICE_DELAY_MS));
    void pollHealth();
  }, WAKE_NOTICE_DELAY_MS);

  const timeoutTimer = window.setTimeout(() => {
    if (requestId !== activeRequestId) return;
    timedOut = true;
    pollingStopped = true;
    healthController?.abort();
    controller.abort();
    showRequestStatus(requestUiState(REQUEST_TIMEOUT_MS), retry);
  }, REQUEST_TIMEOUT_MS);

  try {
    const response = await fetch(path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    const payload = await response.json() as T & { error?: string };
    if (response.status === 429 || response.status === 503 || response.status === 504) {
      const message = payload.error ?? "Qloo is rate-limiting us, try again in a minute";
      keepStatus = true;
      showRequestStatus({ phase: "timed-out", message, canRetry: true }, retry);
      requestStatus.classList.add("error");
      throw new RetryableRequestError(message);
    }
    if (!response.ok) throw new Error(payload.error ?? "The discovery path closed unexpectedly.");
    return payload;
  } catch (error) {
    if (timedOut) throw new RequestTimeoutError();
    throw error;
  } finally {
    pollingStopped = true;
    healthController?.abort();
    window.clearTimeout(wakeTimer);
    window.clearTimeout(timeoutTimer);
    if (healthPollTimer !== undefined) window.clearTimeout(healthPollTimer);
    if (!timedOut && !keepStatus && requestId === activeRequestId) hideRequestStatus();
  }
}

function typeLabel(type: TargetType) {
  return type.replace("_", " ").toUpperCase();
}

function renderCard(item: Recommendation) {
  const article = document.createElement("article");
  article.className = "recommendation-card";
  article.dataset.id = item.id;

  // The sprite tile is picked by card position, so it says nothing about the result: decorative, hidden from AT.
  const sprite = () => {
    const tile = document.createElement("div");
    tile.className = "card-art";
    tile.setAttribute("aria-hidden", "true");
    tile.style.backgroundPosition = `${(item.artIndex % 5) * 25}% ${Math.floor(item.artIndex / 5) * 100}%`;
    return tile;
  };
  let art: HTMLElement = sprite();
  if (item.imageUrl) {
    // Qloo's own image of this entity: real content, so it gets real alt text. Falls back to the sprite if it fails.
    const image = document.createElement("img");
    image.className = "card-art card-photo";
    image.src = item.imageUrl;
    image.alt = `${item.title} (image from Qloo)`;
    image.loading = "lazy";
    image.decoding = "async";
    image.referrerPolicy = "no-referrer";
    image.addEventListener("error", () => image.replaceWith(sprite()), { once: true });
    art = image;
  }

  const content = document.createElement("div");
  content.className = "card-content";
  const heading = document.createElement("div");
  heading.className = "card-heading";
  const h3 = document.createElement("h3");
  h3.textContent = item.title;
  const typeChip = document.createElement("span");
  typeChip.className = "type-chip";
  typeChip.textContent = typeLabel(item.type);
  const obscurityMark = document.createElement("span");
  obscurityMark.className = "obscurity-mark";
  obscurityMark.innerHTML = "<i aria-hidden=\"true\"></i>";
  obscurityMark.append(document.createTextNode(item.badge ?? "reach unknown"));
  if (item.popularity !== undefined) obscurityMark.title = `Qloo popularity ${item.popularity.toFixed(2)}`;
  heading.append(h3, typeChip, obscurityMark);

  const reasons = document.createElement("div");
  reasons.className = "reason-list";
  // Every source Qloo named, strongest first; the score sits in the tooltip to keep the card tidy.
  item.becauseOf.forEach((reason, index) => {
    const chip = document.createElement("span");
    chip.textContent = `Because of ${reason}`;
    const score = item.becauseOfScores?.[index];
    chip.title = typeof score === "number" ? `Qloo explainability score ${score.toFixed(2)}` : "Qloo gave no score for this source";
    if (reason === item.bridgedFrom) {
      chip.classList.add("bridged");
      chip.textContent = `Seeded from ${reason}`;
      chip.title = `Not a Qloo citation: the agent seeded its extra query with ${reason} alone, then kept this card because it shares tags with your other interests`;
    }
    reasons.append(chip);
  });
  if (item.bridgedFrom && item.sharedTags?.length) {
    const shared = document.createElement("p");
    shared.className = "shared-tags";
    shared.textContent = `Shares tags with your other picks: ${item.sharedTags.join(" · ")}`;
    reasons.append(shared);
  }
  if (!item.bridgedFrom && (!item.explainabilityPresent || item.becauseOf.length === 0)) {
    const absent = document.createElement("p");
    absent.className = "no-explanation";
    absent.textContent = "Qloo did not say why";
    reasons.append(absent);
  }
  const footer = document.createElement("div");
  footer.className = "card-footer";
  const copyText = (item.oneLiner ?? item.explanation ?? "").trim();
  const known = document.createElement("button");
  known.type = "button";
  known.className = "known-button";
  known.textContent = "I already know this";
  known.addEventListener("click", () => exclude(item, article, known));
  const actions = document.createElement("div");
  actions.className = "card-actions";
  const openIn = document.createElement("span");
  openIn.className = "open-in";
  openIn.append("Open in");
  // Visible text is the service name; the hidden part gives screen readers the title and the new-tab hint.
  const hidden = (text: string) => {
    const span = document.createElement("span");
    span.className = "sr-only";
    span.textContent = text;
    return span;
  };
  for (const link of openInLinks(item.type, item.title, item.type === "place" ? cityInput.value : undefined)) {
    const anchor = document.createElement("a");
    anchor.className = "search-link";
    anchor.href = link.url;
    anchor.target = "_blank";
    anchor.rel = "noopener noreferrer";
    anchor.append(hidden("Search "), link.label, hidden(` for “${item.title}” (opens in a new tab)`));
    openIn.append(anchor);
  }
  actions.append(openIn, known);
  if (copyText) {
    const copy = document.createElement("p");
    copy.textContent = copyText;
    footer.append(copy);
  }
  footer.append(actions);
  content.append(heading, reasons, footer);
  article.append(art, content);
  return article;
}

/** Each resolved input's share of the visible cards (by "because of"), with a flag on the bridged input. */
function renderBridgeBar() {
  const bar = $("bridge-bar");
  const list = $("bridge-list");
  bar.hidden = resolvedNames.length < 2 || recommendations.length === 0;
  if (bar.hidden) return;
  const total = recommendations.length;
  list.replaceChildren(...resolvedNames.map((name) => {
    // Qloo-cited and agent-seeded are counted apart: a seeded card is the app's own attribution, not Qloo's.
    const seeded = recommendations.filter((item) => item.bridgedFrom === name).length;
    const cited = recommendations.filter((item) => item.bridgedFrom !== name && item.becauseOf.includes(name)).length;
    const row = document.createElement("li");
    row.className = cited === 0 ? "uncited" : "";
    const label = document.createElement("span");
    label.className = "bridge-name";
    label.textContent = name;
    const meter = document.createElement("span");
    meter.className = "bridge-meter";
    meter.setAttribute("aria-hidden", "true");
    const fill = document.createElement("i");
    fill.style.width = `${Math.round((cited / total) * 100)}%`;
    meter.append(fill);
    if (seeded) {
      const seededFill = document.createElement("i");
      seededFill.className = "seeded";
      seededFill.style.left = fill.style.width;
      seededFill.style.width = `${Math.round((seeded / total) * 100)}%`;
      meter.append(seededFill);
    }
    const share = document.createElement("span");
    share.className = "bridge-count";
    share.textContent = ` · ${cited} cited${seeded ? ` · ${seeded} seeded` : ""}`;
    share.title = `${cited} of ${total} cards cite it in Qloo's explainability${seeded ? `; ${seeded} came from the agent's extra query seeded with it` : ""}`;
    row.append(label, share, meter);
    if (name === bridgedInput && bridgeSummary) {
      const flag = document.createElement("span");
      flag.className = "bridge-flag";
      const { candidates, passed, merged } = bridgeSummary;
      flag.textContent = merged ? `extra query: ${merged} of ${candidates} kept` : `extra query: none relevant enough`;
      flag.title = `Cited by no card, so the agent fetched ${candidates} candidates seeded with it alone; ${passed} shared 2+ tags with your other interests${merged ? `, ${merged} merged` : ", so none were merged"}`;
      row.append(flag);
    }
    return row;
  }));
}

function renderResults(response: DiscoveryResponse, isDemoRun = false) {
  recommendations = response.recommendations;
  baseTrace = response.trace;
  refillTraces = [];
  resolvedNames = (response.resolved ?? []).map((entity) => entity.name);
  bridgedInput = response.bridgedInput;
  bridgeSummary = response.bridge;
  grid.replaceChildren(...recommendations.map(renderCard));
  renderBridgeBar();
  results.hidden = false;
  empty.hidden = true;
  $("trace-panel").hidden = false;
  $("result-summary").textContent = response.error ?? `${recommendations.length} new paths, connected to what you already love.`;
  setModeBadge(response.mode);
  demoPill.hidden = !isDemoRun;
  renderTrace(recommendations.length);
  if (response.error) $("trace-status").textContent = "Not run: no input matched";
  $<HTMLDetailsElement>("trace-panel").open = isDemoRun;
  if (response.error) showRequestError(response.error);
}

function traceStep(step: TraceStep, number: string) {
  const row = document.createElement("li");
  const badge = document.createElement("span");
  badge.className = "trace-number";
  badge.textContent = number;
  const copy = document.createElement("div");
  const strong = document.createElement("strong");
  strong.textContent = step.title;
  const detail = document.createElement("p");
  detail.textContent = step.detail;
  copy.append(strong, detail);
  row.append(badge, copy);
  return row;
}

/** The discovery run's full trace, then one sub-section per refill (appended, never replacing the run). */
function renderTrace(countFound: number) {
  const list = $("trace-list");
  const rows = baseTrace.map((step, index) => traceStep(step, String(index + 1).padStart(2, "0")));
  refillTraces.forEach((refill, refillIndex) => {
    const section = document.createElement("li");
    section.className = "trace-sub";
    const heading = document.createElement("strong");
    heading.textContent = refill.label;
    const steps = document.createElement("ol");
    steps.className = "trace-sublist";
    steps.setAttribute("aria-label", refill.label);
    steps.append(...refill.steps.map((step, index) => traceStep(step, `R${refillIndex + 1}.${index + 1}`)));
    section.append(heading, steps);
    rows.push(section);
  });
  list.replaceChildren(...rows);
  $("trace-status").textContent = `${countFound} new paths found${refillTraces.length ? ` · ${refillTraces.length} refill${refillTraces.length === 1 ? "" : "s"}` : ""}`;
}

async function discover(isDemoRun = false, reuseIds = false) {
  if (interests.length < 3 || interests.length > 5) {
    showToast("Choose 3 to 5 things you love first.");
    interestInput.focus();
    return;
  }
  if (target.value === "place" && !cityInput.value.trim()) {
    showToast("Add a city for place discovery.");
    cityInput.focus();
    return;
  }
  results.hidden = false;
  empty.hidden = true;
  setLoading(true);
  $("bridge-bar").hidden = true;
  if (!reuseIds) unresolvedNames.clear();
  renderInterests();
  try {
    // Known items stay out across re-runs; only a different set of inputs (or Start over) clears them.
    exclusions = carryExclusions(exclusions, interests.map((interest) => interest.name));
    const response = await api<DiscoveryResponse>("/api/discover", currentInput(reuseIds), () => void discover(isDemoRun, reuseIds));
    applyMatches(response);
    renderResults(response, isDemoRun);
  } catch (error) {
    if (error instanceof RequestTimeoutError) {
      if (recommendations.length) grid.replaceChildren(...recommendations.map(renderCard));
    } else {
      showToast(error instanceof Error ? error.message : "Discovery failed.");
      if (recommendations.length) grid.replaceChildren(...recommendations.map(renderCard)); else showEmpty();
    }
  } finally {
    setLoading(false);
  }
}

async function exclude(item: Recommendation, article: HTMLElement, button: HTMLButtonElement) {
  button.disabled = true;
  button.textContent = "Finding another…";
  article.classList.add("departing");
  try {
    const response = await api<DiscoveryResponse>("/api/exclude", {
      ...currentInput(true),
      knownId: item.id,
      currentIds: recommendations.map((entry) => entry.id),
    }, () => void exclude(item, article, button));
    exclusions = addExclusion(exclusions, item.id);
    const index = recommendations.findIndex((entry) => entry.id === item.id);
    if (response.recommendations[0]) {
      response.recommendations[0].artIndex = item.artIndex;
      recommendations.splice(index, 1, response.recommendations[0]);
    }
    else recommendations.splice(index, 1);
    const replacement = response.recommendations[0] ? renderCard(response.recommendations[0]) : undefined;
    article.replaceWith(...(replacement ? [replacement] : []));
    // Keyboard and screen-reader users land on the new card instead of losing focus with the removed button.
    if (replacement) {
      replacement.tabIndex = -1;
      replacement.setAttribute("aria-label", `New card: ${response.recommendations[0]!.title}`);
      replacement.focus();
    } else {
      grid.querySelector<HTMLButtonElement>(".known-button")?.focus();
    }
    const replacedWith = response.recommendations[0]?.title;
    refillTraces.push({
      label: `Refill ${refillTraces.length + 1}: “${item.title}” known → ${replacedWith ? `“${replacedWith}”` : "no replacement left"}`,
      steps: response.trace,
    });
    renderTrace(recommendations.length);
    renderBridgeBar();
    $("result-summary").textContent = `${recommendations.length} new paths · known discoveries stay out.`;
    showToast("Known path removed. A new one is in its place.");
  } catch (error) {
    article.classList.remove("departing");
    button.disabled = false;
    button.textContent = "I already know this";
    if (!(error instanceof RequestTimeoutError)) {
      showToast(error instanceof Error ? error.message : "Could not refill that card.");
    }
  }
}

function loadExample(example: (typeof examples)[number]) {
  interests = example.interests.map((item) => ({ ...item }));
  unresolvedNames.clear();
  matchByName.clear();
  target.value = example.targetType;
  cityInput.value = example.city ?? "";
  updateTarget();
  renderInterests();
  void discover();
}

/** The three examples live in two places: the empty state (large) and a small row under the input (always shown). */
function renderExamples() {
  $("example-list").replaceChildren(...examples.map((example, index) => {
    const button = document.createElement("button");
    button.type = "button";
    button.innerHTML = `<span>0${index + 1}</span>`;
    button.append(document.createTextNode(example.label));
    button.addEventListener("click", () => loadExample(example));
    return button;
  }));
  $("example-row").replaceChildren(...examples.map((example) => {
    const item = document.createElement("li");
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = example.short;
    button.title = example.label;
    button.addEventListener("click", () => loadExample(example));
    item.append(button);
    return item;
  }));
}

function updateTarget() {
  cityField.hidden = target.value !== "place";
}

interestInput.addEventListener("keydown", (event) => {
  if (event.key === "Enter" || event.key === ",") { event.preventDefault(); addInterest(); }
});
interestInput.addEventListener("blur", addInterest);
target.addEventListener("change", updateTarget);
let distanceRerunTimer: number | undefined;
distance.addEventListener("input", () => {
  const value = Number(distance.value) as Distance;
  distanceValue.textContent = distanceLabels[value];
  distance.setAttribute("aria-valuetext", distanceLabels[value]!);
  distance.style.setProperty("--distance-progress", `${value * 50}%`);
  // Results already on screen follow the slider (debounced so arrow-key steps send one request).
  window.clearTimeout(distanceRerunTimer);
  if (!results.hidden && recommendations.length && !discoverButton.disabled) {
    distanceRerunTimer = window.setTimeout(() => void discover(false, true), 450);
  }
});
discoverButton.addEventListener("click", () => void discover());
demoPill.addEventListener("click", () => {
  $("composer-title").scrollIntoView({ behavior: "smooth", block: "center" });
  window.setTimeout(() => interestInput.focus(), 350);
});
$("clear-button").addEventListener("click", () => {
  interests = [];
  unresolvedNames.clear();
  matchByName.clear();
  recommendations = [];
  exclusions = NO_EXCLUSIONS;
  resolvedNames = [];
  bridgedInput = undefined;
  bridgeSummary = undefined;
  renderInterests();
  showEmpty();
  interestInput.focus();
});

renderExamples();
renderInterests();
updateTarget();
distance.dispatchEvent(new Event("input"));
void discover(true);
