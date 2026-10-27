import {
  HEALTH_POLL_INTERVAL_MS,
  HEALTH_POLL_TIMEOUT_MS,
  REQUEST_TIMEOUT_MS,
  WAKE_NOTICE_DELAY_MS,
  requestUiState,
  type RequestUiState,
} from "./request-policy.js";

type TargetType = "artist" | "book" | "podcast" | "movie" | "tv_show" | "video_game" | "place";
type Distance = 0 | 1 | 2;
type Recommendation = { id: string; title: string; type: TargetType; becauseOf: string[]; becauseOfScores?: Array<number | null>; distance: Distance; explanation: string; oneLiner?: string; artIndex: number; explainabilityPresent: boolean; popularity?: number; badge?: string };
type TraceStep = { stage: string; title: string; detail: string };
type Entity = { id: string; name: string; type: string };
type Match = { interest: string; entity?: Entity; alternatives?: Entity[] };
type DiscoveryResponse = { recommendations: Recommendation[]; trace: TraceStep[]; mode: "mock" | "http"; unresolved: string[]; matches?: Match[]; error?: string };
/** One input: `type` is an explicit hint, `id` a match the user picked from the type-chip picker. */
type Interest = { name: string; type?: string; id?: string };

const examples: Array<{ label: string; interests: Interest[]; targetType: TargetType; city?: string }> = [
  { label: "Blade Runner 2049 + The Left Hand of Darkness + Disco Elysium → artists", interests: [{ name: "Blade Runner 2049", type: "movie" }, { name: "The Left Hand of Darkness", type: "book" }, { name: "Disco Elysium", type: "video_game" }], targetType: "artist" },
  { label: "Nausicaa (film) + Braiding Sweetgrass (book) + Patagonia (brand) → places in Kyoto", interests: [{ name: "Nausicaa", type: "movie" }, { name: "Braiding Sweetgrass", type: "book" }, { name: "Patagonia", type: "brand" }], targetType: "place", city: "Kyoto" },
  { label: "Hades (game) + Hadestown (Broadway show) + Circe (book) → podcasts", interests: [{ name: "Hades", type: "video_game" }, { name: "Hadestown", type: "place" }, { name: "Circe", type: "book" }], targetType: "podcast" },
];

const distanceLabels = ["Next door", "Across town", "Out of the bubble"];
let interests: Interest[] = examples[0].interests.map((item) => ({ ...item }));
let recommendations: Recommendation[] = [];
let excludedIds: string[] = [];
let latestTrace: TraceStep[] = [];
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
    chip.textContent = unresolved ? "no match" : shownType ? typeText(shownType) : "auto";
    chip.setAttribute("aria-haspopup", "true");
    chip.setAttribute("aria-expanded", String(openPickerIndex === index));
    chip.setAttribute("aria-label", `${interest.name}: ${unresolved ? "no match" : `matched as ${chip.textContent}`}. Show other matches`);
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
  unresolvedNames = new Set(response.unresolved.map((name) => name.toLocaleLowerCase()));
  matchByName = new Map((response.matches ?? []).map((match) => [match.interest.toLocaleLowerCase(), match]));
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
  interests[index] = { name: entity.name, type: entity.type, id: entity.id };
  const key = entity.name.toLocaleLowerCase();
  matchByName.set(key, { interest: entity.name, entity });
  unresolvedNames.delete(key);
  closePicker();
  renderInterests();
  chipAt(index)?.focus();
  showToast(`Now using ${entity.name} (${typeText(entity.type)}).`);
  if (!results.hidden && recommendations.length) void discover();
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
      body: JSON.stringify({ interests: [{ name: interest.name }], alternatives: true }),
    });
    const payload = await response.json() as { matches?: Match[]; error?: string };
    if (pickerPanel !== panel) return;
    if (!response.ok) throw new Error(payload.error ?? "lookup failed");
    const found = payload.matches?.[0];
    const currentId = matchByName.get(interest.name.toLocaleLowerCase())?.entity?.id ?? interest.id;
    const seen = new Set(currentId ? [currentId] : []);
    const options = [found?.entity, ...(found?.alternatives ?? [])]
      .filter((entity): entity is Entity => Boolean(entity) && !seen.has(entity!.id) && (seen.add(entity!.id), true))
      .slice(0, 3);
    status.textContent = options.length ? "Switch this input to:" : "No other close matches in Qloo.";
    panel.append(...options.map((entity) => {
      const option = document.createElement("button");
      option.type = "button";
      option.append(document.createTextNode(entity.name));
      const kind = document.createElement("span");
      kind.textContent = ` · ${typeText(entity.type)}`;
      option.append(kind);
      option.addEventListener("click", () => pickMatch(index, entity));
      return option;
    }));
    (panel.querySelector("button") ?? chip).focus();
  } catch {
    if (pickerPanel === panel) status.textContent = "Could not load other matches.";
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

function currentInput() {
  return {
    interests,
    targetType: target.value as TargetType,
    distance: Number(distance.value) as Distance,
    city: target.value === "place" ? cityInput.value.trim() : undefined,
    excludeIds: excludedIds,
  };
}

async function api<T>(path: string, body: object, retry: () => void): Promise<T> {
  const requestId = ++activeRequestId;
  const controller = new AbortController();
  let healthController: AbortController | undefined;
  let healthPollTimer: number | undefined;
  let pollingStopped = false;
  let timedOut = false;
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
    if (!timedOut && requestId === activeRequestId) hideRequestStatus();
  }
}

function typeLabel(type: TargetType) {
  return type.replace("_", " ").toUpperCase();
}

function renderCard(item: Recommendation) {
  const article = document.createElement("article");
  article.className = "recommendation-card";
  article.dataset.id = item.id;

  const art = document.createElement("div");
  art.className = "card-art";
  art.role = "img";
  art.setAttribute("aria-label", `Editorial artwork for ${item.title}`);
  const col = item.artIndex % 5;
  const row = Math.floor(item.artIndex / 5);
  art.style.backgroundPosition = `${col * 25}% ${row * 100}%`;

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
    reasons.append(chip);
  });
  if (!item.explainabilityPresent || item.becauseOf.length === 0) {
    const absent = document.createElement("p");
    absent.className = "no-explanation";
    absent.textContent = "Qloo did not say why";
    reasons.append(absent);
  }
  const footer = document.createElement("div");
  footer.className = "card-footer";
  const copy = document.createElement("p");
  copy.textContent = item.oneLiner ?? item.explanation;
  const known = document.createElement("button");
  known.type = "button";
  known.className = "known-button";
  known.textContent = "I already know this";
  known.addEventListener("click", () => exclude(item, article, known));
  const actions = document.createElement("div");
  actions.className = "card-actions";
  const search = document.createElement("a");
  search.className = "search-link";
  search.href = `https://duckduckgo.com/?q=${encodeURIComponent(`${item.title} ${typeLabel(item.type).toLowerCase()}`)}`;
  search.target = "_blank";
  search.rel = "noopener noreferrer";
  search.textContent = "Search the web";
  actions.append(search, known);
  footer.append(copy, actions);
  content.append(heading, reasons, footer);
  article.append(art, content);
  return article;
}

function renderResults(response: DiscoveryResponse, isDemoRun = false) {
  recommendations = response.recommendations;
  latestTrace = response.trace;
  grid.replaceChildren(...recommendations.map(renderCard));
  results.hidden = false;
  empty.hidden = true;
  $("trace-panel").hidden = false;
  $("result-summary").textContent = response.error ?? `${recommendations.length} new paths, connected to what you already love.`;
  setModeBadge(response.mode);
  demoPill.hidden = !isDemoRun;
  renderTrace(response.trace, recommendations.length);
  if (response.error) $("trace-status").textContent = "Not run: no input matched";
  $<HTMLDetailsElement>("trace-panel").open = isDemoRun;
  if (response.error) showRequestError(response.error);
}

function renderTrace(trace: TraceStep[], countFound: number) {
  const list = $("trace-list");
  list.replaceChildren(...trace.map((step, index) => {
    const row = document.createElement("li");
    const number = document.createElement("span");
    number.className = "trace-number";
    number.textContent = String(index + 1).padStart(2, "0");
    const copy = document.createElement("div");
    const strong = document.createElement("strong");
    strong.textContent = step.title;
    const detail = document.createElement("p");
    detail.textContent = step.detail;
    copy.append(strong, detail);
    row.append(number, copy);
    return row;
  }));
  $("trace-status").textContent = `${countFound} new paths found`;
}

async function discover(isDemoRun = false) {
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
  unresolvedNames.clear();
  renderInterests();
  try {
    excludedIds = [];
    const response = await api<DiscoveryResponse>("/api/discover", currentInput(), () => void discover(isDemoRun));
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
      ...currentInput(),
      knownId: item.id,
      currentIds: recommendations.map((entry) => entry.id),
    }, () => void exclude(item, article, button));
    excludedIds.push(item.id);
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
    latestTrace = response.trace;
    renderTrace(response.trace, recommendations.length);
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

function renderExamples() {
  const list = $("example-list");
  list.replaceChildren(...examples.map((example, index) => {
    const button = document.createElement("button");
    button.type = "button";
    button.innerHTML = `<span>0${index + 1}</span>`;
    button.append(document.createTextNode(example.label));
    button.addEventListener("click", () => {
      interests = example.interests.map((item) => ({ ...item }));
      unresolvedNames.clear();
      matchByName.clear();
      target.value = example.targetType;
      cityInput.value = example.city ?? "";
      updateTarget();
      renderInterests();
      void discover();
    });
    return button;
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
    distanceRerunTimer = window.setTimeout(() => void discover(), 450);
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
  excludedIds = [];
  renderInterests();
  showEmpty();
  interestInput.focus();
});

renderExamples();
renderInterests();
updateTarget();
distance.dispatchEvent(new Event("input"));
void discover(true);
