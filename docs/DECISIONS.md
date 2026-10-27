# Decisions

This file records the reasonable product and engineering choices made while implementing the work order without an API key or a review pause.

## Product and interaction

- The app opens with the first example sample mix already filled and immediately runs discovery. A clickable “Demo run — try your own” label prevents the automatic result set from looking like user-generated or live data. “Start over” reveals the required empty state and its three clickable prompts; the same three also sit in a small always-visible row under the input. The client waits 65 s before offering a retry, matching the “up to a minute” wake notice.
- Discovery returns ten cards by default (Qloo `take=10`; Qloo ignores `limit`). Every supported target type has sixteen dedicated mock records, leaving refill capacity after ten visible exclusions.
- “I already know this” is stateless at the server boundary. The browser sends the known ID plus every currently visible ID; `/api/exclude` asks the agent for one result outside that set and replaces the card in place. This makes the API horizontally deployable without sessions.
- A city is required only when the target category is `place`. The form reveals the city control conditionally and sends it as `filter.location.query`.
- Data mode is explicit: mock responses and `/api/health` produce the amber “Sample data — real Qloo key pending” badge; HTTP mode produces the green “Live Qloo” badge. No euphemism is used for sample data.
- An input that `/search` cannot resolve is returned in `unresolved`, kept visible as a dashed/struck-through token with a “no match” chip, and never used as evidence. Discovery continues with at least one resolved input; with none, the agent does not call `/v2/insights` at all, and the response carries a visible error, no recommendations and no “new paths” copy.
- After “I already know this”, focus moves to the replacement card. The distance slider carries `aria-valuetext` with the stop name and, when results are on screen, re-runs discovery 450 ms after the last change.
- The page follows `prefers-color-scheme`: a light parchment variant of the same warm palette, no toggle.
- The demo trace opens by default. It records every input resolution, the exact outbound insight parameters, result count, explainability count, and the complete exclusion list for refill.

## Qloo mapping

- Distance is a three-value domain (`0`, `1`, `2`) shared by the UI, agent, and tests.
- **Next door:** `bias.trends=high`, `filter.popularity.min=0.24`; mock results rank highest popularity first.
- **Across town:** `bias.trends=low`, `filter.popularity.min=0.08`, `filter.popularity.max=0.96`; mock results alternate high and low popularity.
- **Out of the bubble:** `bias.trends=low`, `filter.popularity.max=0.65`; mock results rank lowest popularity first. (Was 0.8 until 2026-10-27; lowered so the far-out cap sits below the "well known" badge floor of 0.85 and most far-out cards read "familiar" or "deep cut". `diversify.by` was never sent and the dead field is gone.)
- **Self-correcting decision step:** after the first `/v2/insights` call, if fewer than 6 results came back (or fewer than `take` when `take` < 6), or explainability is present on under 50% of them, the agent retries exactly once with one looser setting. Too few results: raise `filter.popularity.max` one notch (+0.15, so 0.65 → 0.8), else drop `bias.trends`, else drop `filter.popularity.min`. Too little explainability: drop `bias.trends`, else raise the cap. It keeps whichever run is better (enough results, then enough explained, then more results, then more explained) and writes one `Decision: … because …` line to the trace. If no retry was needed the line reads `Decision: kept first query (10 results, 10/10 explained)`.
- **Type-aware resolver:** an input may carry an explicit type hint (`{ name, type }`); then `/search` runs with `types=urn:entity:<hint>` and only hits of that type count. Without a hint, `/search` runs with `types` = movie, book, video_game, tv_show, album, artist, podcast, brand, and locality/place/destination hits never win. If the typed search yields no name match, an untyped `/search` runs with the same name match and type rule. Name match: exact (after normalization) or the *query* contained whole-word in the hit name, or Levenshtein similarity ≥ 0.8; a hit that is only a fragment of the query ("Nonexistent" for "Flimzap Nonexistent") does not count. The examples carry hints: Nausicaa → movie, Braiding Sweetgrass → book, Patagonia → brand, Hades → video_game, Hadestown → place (Qloo models the Broadway production as a place entity tagged "Broadway musical"; no other Hadestown entity appeared in /search).
- **Match picker:** each input token shows the matched type as a small button. It opens the top three other matches from `/api/resolve` (`alternatives: true`, the input's type hint sent along; typed hits first, then other entity types from the untyped search fill any room; name similarity ≥ 0.6). Names are HTML-entity-decoded, one row per name+type (the current match counts), and a year/author disambiguator is shown when the Qloo search row carries one. Picking one pins that entity id for the input and re-runs discovery when results are on screen.
- **Taste bridge v2 (relevance-gated):** after Decide, the agent counts how many cards cite each resolved input. If one is cited by 0 cards (full pages only, 2+ inputs), one extra `/v2/insights` call seeded with that input alone (same type/distance parameters, `take=8`, first-page IDs excluded) returns a *candidate pool*. v1 merged 4 such cards unconditionally; a reviewer found them off-taste (rockabilly and Brazilian funk for a sci-fi novel, a football podcast for Hadestown, romance novels for Aesop), so v2 gates them:
  - Score = number of the candidate's Qloo `tags` (insights rows carry them; the client passes them through) that also appear in the union of the OTHER inputs' tags (from `/search`; cached by id so re-runs with reused ids still have them, else one typed `/search` per input fills them). Tags compare case-, accent- and punctuation-insensitively; format/platform/age-bracket tags ("Audiobook", "Paperback", "18-24", "Microsoft Windows", "Single-player"…) never count. Ties: higher affinity (`query.affinity`, else `score`), then popularity.
  - Gate: shared tags ≥ 2. At most 3 merge, each replacing the lowest-affinity first-page card that is not some input's only citation (if no such card is left, fewer merge). No passing candidate → nothing merges and the line says `0 passed the relevance gate` (with the best near-misses).
  - Threshold 2 is tuned on the mock only. Live tuning needs one default-example run on the deployed v2 (the old live code does not expose candidate tags); the trace prints `other inputs' tags=N` and the best near-misses for that. If live data never reaches 2, the rule drops to ≥ 1 and this line will say so.
  - A merged card carries `bridgedFrom` (rendered "Seeded from …"), `becauseOf` = only the seed, score `null`, `explainabilityPresent=false`, and `sharedTags`. The bar counts Qloo-cited and seeded cards separately. Only one extra call; if it fails, the first page stands. One-card refills never bridge.
- **Exclusions persist:** the browser keeps "I already know this" ids across slider moves, match switches and refills and sends them on every `/api/discover`; they reset only on Start over or when the set of typed inputs changes (`web/src/exclusions.ts`).
- **Picker keeps typed text:** switching a match changes only the id and type; the token keeps what the user typed, and the chip shows "typed → matched · type".
- **Albums:** unhinted inputs also search `urn:entity:album` (in Qloo's own allowed list, kept from its 400 message), so *Kind of Blue* can resolve to the album rather than a 2016 book of the same name. A rejected typed search now logs a 300-character excerpt of Qloo's 400 text in the Resolve trace.
- **Resolved-id reuse:** refills, slider re-runs and picker switches send `{ id, name, type }` for every resolved input, so `/search` is skipped ("reused N resolved ids"). "Break the bubble" and the examples resolve afresh (picked ids still stick).
- Live calls use only `https://hackathon.api.qloo.com`, send the key only as `X-Api-Key`, resolve through `/search`, and discover through `/v2/insights` with the required `filter.type=urn:entity:<type>` and `feature.explainability=true`.
- The live response adapter accepts the common `results`, `results.entities`, `data`, and `data.entities` envelopes. This is defensive parsing rather than a checked-in Qloo response; no real response data is stored in the project.
- Mock fixture names and descriptions are deliberately fictional. The 112-item pool has sixteen unique names for each supported target type, with explicit `popularity` and `trend` values; names are never relabelled across types.
- Explainability is never inferred from the user’s first inputs. A recommendation gets `becauseOf` entries only when the Qloo payload names or IDs a resolved source; otherwise it carries `becauseOf: []`, `explainabilityPresent: false`, and the UI states “Qloo did not say why”.
- Card obscurity labels are per-item metadata derived from Qloo popularity (`obscurityBadge` in `server/src/distance.ts`, sent as `badge`): `>= 0.85` is “well known”, `0.6` to `0.85` is “familiar”, and below `0.6` is “deep cut”. The results header repeats these thresholds as a one-line legend. These labels do not repeat the global distance control.
- “Because of” chips list every explainability source Qloo returns that maps to a resolved input (no cut at two), strongest score first; the score is in the chip's tooltip.
- “Search the web” uses a plain DuckDuckGo title-and-type URL. It needs no API, sends no hidden application state, and opens with `noopener noreferrer`.

## LLM behavior

- OpenAI is optional and called server-side through the Responses API. One batch request asks for one-line hooks for all cards.
- If `OPENAI_API_KEY` is absent or the request fails, discovery does not fail. The UI renders the Qloo explanation only, exactly as required.
- `OPENAI_MODEL` defaults to `gpt-5-mini`.

## Visual system

- The accepted implementation direction is a warm, dark editorial “observatory”: near-black plum, parchment text, ember coral actions, muted lilac signals, and a high-contrast serif paired with a quiet sans-serif.
- The result grid is two columns on desktop and one on phones. Cards use one generated ten-cell editorial atlas as a production image sprite. The tile is chosen by card position, so it is decorative (`aria-hidden`, no alt). When the Qloo insights payload carries an entity image (`properties.image.url` and similar), the card shows that instead, with the title as alt text, and falls back to the sprite if it fails to load.
- Google Fonts are an enhancement only. Georgia and Segoe UI fallbacks preserve hierarchy when the page is offline.
- Motion is limited to loading, hover, and replacement feedback and is disabled through `prefers-reduced-motion`.

## Build and deployment

- TypeScript compiles the Express server with `tsc`; esbuild bundles only the small vanilla TypeScript browser entry. Static files are copied into `dist/web`, and the same Express process serves both API and page.
- `npm start` performs a clean build before launching so the documented command works immediately after `npm install` with no separate build step.
- Render uses the Dockerfile. The final image contains production dependencies, compiled output, and hand-written mock fixtures only.
