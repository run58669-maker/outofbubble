# Decisions

This file records the reasonable product and engineering choices made while implementing the work order without an API key or a review pause.

## Product and interaction

- The app opens with the first example sample mix already filled and immediately runs discovery. A clickable “Demo run — try your own” label prevents the automatic result set from looking like user-generated or live data. “Start over” reveals the required empty state and its three clickable prompts.
- Discovery returns eight cards by default. This is the lower end of the requested 8–10 range and keeps the first result set scan-friendly. Every supported target type has twelve dedicated mock records, leaving refill capacity after eight visible exclusions.
- “I already know this” is stateless at the server boundary. The browser sends the known ID plus every currently visible ID; `/api/exclude` asks the agent for one result outside that set and replaces the card in place. This makes the API horizontally deployable without sessions.
- A city is required only when the target category is `place`. The form reveals the city control conditionally and sends it as `filter.location.query`.
- Data mode is explicit: mock responses and `/api/health` produce the amber “Sample data — real Qloo key pending” badge; HTTP mode produces the green “Live Qloo” badge. No euphemism is used for sample data.
- An input that `/search` cannot resolve is returned in `unresolved`, kept visible as a dashed/struck-through “Not found” chip, and never used as evidence. Discovery continues with at least one resolved input; with none, the response contains a visible error state and no recommendations.
- The demo trace opens by default. It records every input resolution, the exact outbound insight parameters, result count, explainability count, and the complete exclusion list for refill.

## Qloo mapping

- Distance is a three-value domain (`0`, `1`, `2`) shared by the UI, agent, and tests.
- **Next door:** `bias.trends=high`, `diversify.by=entities`, `filter.popularity.min=0.24`; mock results rank highest popularity first.
- **Across town:** `bias.trends=low`, `diversify.by=tags`, `filter.popularity.min=0.08`, `filter.popularity.max=0.96`; mock results alternate high and low popularity.
- **Out of the bubble:** `bias.trends=low`, `diversify.by=tags`, `filter.popularity.max=0.8`; mock results rank lowest popularity first.
- Live calls use only `https://hackathon.api.qloo.com`, send the key only as `X-Api-Key`, resolve through `/search`, and discover through `/v2/insights` with the required `filter.type=urn:entity:<type>` and `feature.explainability=true`.
- The live response adapter accepts the common `results`, `results.entities`, `data`, and `data.entities` envelopes. This is defensive parsing rather than a checked-in Qloo response; no real response data is stored in the project.
- Mock fixture names and descriptions are deliberately fictional. The 84-item pool has twelve unique names for each supported target type, with explicit `popularity` and `trend` values; names are never relabelled across types.
- Explainability is never inferred from the user’s first inputs. A recommendation gets `becauseOf` entries only when the Qloo payload names or IDs a resolved source; otherwise it carries `becauseOf: []`, `explainabilityPresent: false`, and the UI states “Qloo did not say why”.
- Card obscurity labels are per-item metadata derived from popularity: `>= 0.7` is “well known”, `>= 0.35` is “under the radar”, and lower values are “deep cut”. These labels do not repeat the global distance control.
- “Search the web” uses a plain DuckDuckGo title-and-type URL. It needs no API, sends no hidden application state, and opens with `noopener noreferrer`.

## LLM behavior

- OpenAI is optional and called server-side through the Responses API. One batch request asks for one-line hooks for all cards.
- If `OPENAI_API_KEY` is absent or the request fails, discovery does not fail. The UI renders the Qloo explanation only, exactly as required.
- `OPENAI_MODEL` defaults to `gpt-5-mini`.

## Visual system

- The accepted implementation direction is a warm, dark editorial “observatory”: near-black plum, parchment text, ember coral actions, muted lilac signals, and a high-contrast serif paired with a quiet sans-serif.
- The result grid is two columns on desktop and one on phones. Cards use one generated ten-cell editorial atlas as a production image sprite, which keeps the bundle small while giving every result distinct art.
- Google Fonts are an enhancement only. Georgia and Segoe UI fallbacks preserve hierarchy when the page is offline.
- Motion is limited to loading, hover, and replacement feedback and is disabled through `prefers-reduced-motion`.

## Build and deployment

- TypeScript compiles the Express server with `tsc`; esbuild bundles only the small vanilla TypeScript browser entry. Static files are copied into `dist/web`, and the same Express process serves both API and page.
- `npm start` performs a clean build before launching so the documented command works immediately after `npm install` with no separate build step.
- Render uses the Dockerfile. The final image contains production dependencies, compiled output, and hand-written mock fixtures only.
