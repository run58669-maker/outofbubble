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
type Recommendation = { id: string; title: string; type: TargetType; becauseOf: string[]; distance: Distance; explanation: string; oneLiner?: string; artIndex: number; explainabilityPresent: boolean; popularity?: number };
type TraceStep = { stage: string; title: string; detail: string };
type DiscoveryResponse = { recommendations: Recommendation[]; trace: TraceStep[]; mode: "mock" | "http"; unresolved: string[]; error?: string };

const examples: Array<{ label: string; interests: string[]; targetType: TargetType; city?: string }> = [
  { label: "Blade Runner 2049 + The Left Hand of Darkness + Disco Elysium → artists", interests: ["Blade Runner 2049", "The Left Hand of Darkness", "Disco Elysium"], targetType: "artist" },
  { label: "Nausicaa + Braiding Sweetgrass + Patagonia → places in Kyoto", interests: ["Nausicaa", "Braiding Sweetgrass", "Patagonia"], targetType: "place", city: "Kyoto" },
  { label: "Hades + Hadestown + Circe → podcasts", interests: ["Hades", "Hadestown", "Circe"], targetType: "podcast" },
];

const distanceLabels = ["Next door", "Across town", "Out of the bubble"];
let interests = [...examples[0].interests];
let recommendations: Recommendation[] = [];
let excludedIds: string[] = [];
let latestTrace: TraceStep[] = [];
let unresolvedNames = new Set<string>();

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

function renderInterests() {
  tokens.replaceChildren();
  interests.forEach((interest, index) => {
    const token = document.createElement("span");
    token.className = "interest-token";
    if (unresolvedNames.has(interest.toLocaleLowerCase())) {
      token.classList.add("unresolved");
      token.title = "Not found";
    }
    token.append(document.createTextNode(interest));
    const remove = document.createElement("button");
    remove.type = "button";
    remove.setAttribute("aria-label", `Remove ${interest}`);
    remove.textContent = "×";
    remove.addEventListener("click", () => {
      interests.splice(index, 1);
      unresolvedNames.clear();
      renderInterests();
      if (interests.length === 0) showEmpty();
    });
    token.append(remove);
    tokens.append(token);
  });
  count.textContent = `${interests.length} of 5`;
  interestInput.hidden = interests.length >= 5;
  interestBox.classList.toggle("invalid", interests.length > 0 && interests.length < 3);
}

function addInterest() {
  const value = interestInput.value.trim();
  if (!value || interests.length >= 5) return;
  if (interests.some((item) => item.toLowerCase() === value.toLowerCase())) {
    showToast("That one is already in your mix.");
    return;
  }
  interests.push(value);
  unresolvedNames.clear();
  interestInput.value = "";
  renderInterests();
}

function markUnresolved(unresolved: string[]) {
  unresolvedNames = new Set(unresolved.map((name) => name.toLocaleLowerCase()));
  renderInterests();
}

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

function obscurityLabel(popularity?: number) {
  if (popularity === undefined) return "reach unknown";
  if (popularity >= 0.7) return "well known";
  if (popularity >= 0.35) return "under the radar";
  return "deep cut";
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
  obscurityMark.append(document.createTextNode(obscurityLabel(item.popularity)));
  heading.append(h3, typeChip, obscurityMark);

  const reasons = document.createElement("div");
  reasons.className = "reason-list";
  item.becauseOf.forEach((reason) => {
    const chip = document.createElement("span");
    chip.textContent = `Because of ${reason}`;
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
    markUnresolved(response.unresolved);
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
    article.replaceWith(...(response.recommendations[0] ? [renderCard(response.recommendations[0])] : []));
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
      interests = [...example.interests];
      unresolvedNames.clear();
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
distance.addEventListener("input", () => {
  const value = Number(distance.value) as Distance;
  distanceValue.textContent = distanceLabels[value];
  distance.style.setProperty("--distance-progress", `${value * 50}%`);
});
discoverButton.addEventListener("click", () => void discover());
demoPill.addEventListener("click", () => {
  $("composer-title").scrollIntoView({ behavior: "smooth", block: "center" });
  window.setTimeout(() => interestInput.focus(), 350);
});
$("clear-button").addEventListener("click", () => {
  interests = [];
  unresolvedNames.clear();
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
