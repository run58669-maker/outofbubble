# Decisions

This file records the reasonable product and engineering choices made while implementing the work order without an API key or a review pause.

## Product and interaction

- The app opens with the first example constellation already filled and immediately runs discovery. This makes the no-env quick start visibly complete and proves that cards return without setup. “Start over” reveals the required empty state and its three clickable prompts.
- Discovery returns eight cards by default. This is the lower end of the requested 8–10 range, keeps the first result set scan-friendly, and leaves four mock records available to prove exclusion/refill behavior.
- “I already know this” is stateless at the server boundary. The browser sends the known ID plus every currently visible ID; `/api/exclude` asks the agent for one result outside that set and replaces the card in place. This makes the API horizontally deployable without sessions.
- A city is required only when the target category is `place`. The form reveals the city control conditionally and sends it as `filter.location.query`.
- The UI says “Preview constellation” instead of “mock” in the main result area so the demo looks finished, while the agent response still exposes `mode: "mock"` for transparent debugging.

## Qloo mapping

- Distance is a three-value domain (`0`, `1`, `2`) shared by the UI, agent, and tests.
- **Next door:** `bias.trends=high`, `diversify.by=entities`, `filter.popularity.min=0.55`.
- **Across town:** `bias.trends=low`, `diversify.by=tags`, `filter.popularity.min=0.2`.
- **Out of the bubble:** `bias.trends=low`, `diversify.by=tags`, `filter.popularity.max=0.45`.
- Live calls use only `https://hackathon.api.qloo.com`, send the key only as `X-Api-Key`, resolve through `/search`, and discover through `/v2/insights` with the required `filter.type=urn:entity:<type>` and `feature.explainability=true`.
- The live response adapter accepts the common `results`, `results.entities`, `data`, and `data.entities` envelopes. This is defensive parsing rather than a checked-in Qloo response; no real response data is stored in the project.
- Mock fixture names and descriptions are deliberately fictional. The mock client changes their returned entity type to the selected target, which keeps every target category testable with a compact, clearly fake fixture set.

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
