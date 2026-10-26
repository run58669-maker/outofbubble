# Out of the Bubble — work order (2026-10-26 16:35 JST)

Hackathon: Qloo Agentic Hackathon (https://qloo.devpost.com/), theme "Agents, but with taste".
Deadline: 2026-10-30 23:45 EDT = 2026-10-31 12:45 JST. No video. Judged on four equal criteria:
Qloo depth / Design / Potential impact / Quality of idea. Official rule: "if the product still works with Qloo removed, you did it wrong."

## The problem (real quotes)
- HN 2026-09-22: "my Spotify recommendation algorithm complaint is … that it's too conservative… I feel stuck in a musical 'echo chamber.'" https://news.ycombinator.com/item?id=49797896
- HN 2026-08-04: "Recommendations have gotten noticeably worse since the glory days of Discover Weekly…" https://news.ycombinator.com/item?id=49173215
- r/indieheads 2026-06-21 (107 upvotes): "I often open Spotify or YouTube intending to find something unfamiliar, but recommendations lead me back to the same artists, genres, and moods." https://reddit.com/r/indieheads/comments/1ubrp0p/

## What we build
A web app + agent. The user gives 3–5 things they love from ANY category (a movie, a book, a game, a podcast, a brand, a place…). They choose one TARGET category (artist / book / podcast / movie / tv_show / video_game / place-in-a-city) and a DISTANCE slider (comfort zone → far out). The agent returns 8–10 cards they have likely never met, each with "because of your X and Y" (Qloo explainability) and a short LLM-written one-liner. User can mark a card "already know it" → it is excluded and the agent refills. Cross-category is the point: your films and books pick your next band.

## Qloo API facts (from the official kit, non-negotiable)
- Base URL `https://hackathon.api.qloo.com` only. Header `X-Api-Key: <key>`. Never Bearer, never query.
- `GET /search?query=…` to resolve names → entity ids. `GET /v2/insights` with `filter.type=urn:entity:<type>` REQUIRED. Do not use `/recs` or `/recommendations`.
- Signals: `signal.interests.entities=<ids,comma>`, `signal.interests.tags`. Exclude: `filter.exclude.entities`. Location for places: `filter.location.query=<city>`. Spice: `bias.trends=low|high`, `diversify.by`. Explanations: `feature.explainability=true`.
- Entity types: artist, book, brand, destination, movie, person, place, podcast, tv_show, video_game.
- Key must live server-side only (proxy). Do NOT commit Qloo responses to the repo. Do NOT send personal data to Qloo, only entity names/ids/tags.
- Key is NOT here yet (requested via form, arrives by email). Build a `QlooClient` interface with two impls: `MockQlooClient` (fixtures in `fixtures/*.json`, hand-written, clearly fake names are fine) and `HttpQlooClient`. Select via env `QLOO_API_KEY` present → http, else mock. Everything must run end-to-end in mock mode today.

## Stack (decided)
- Node 20 + TypeScript, Express (or Fastify). One `server/` package. Static `web/` served by the same server: plain HTML + a small amount of vanilla TS compiled by esbuild, NO React. Single page.
- LLM for the one-liners: OpenAI Responses API via `OPENAI_API_KEY` (optional; if absent, skip the one-liner and show only the Qloo explanation). Keep model name in env `OPENAI_MODEL`, default `gpt-5-mini`.
- Agent loop lives in `server/src/agent.ts`: resolve → insights (with distance mapping to bias/popularity filters) → explain → (on "already know") exclude+refill. Log each step to an in-memory trace that the UI shows in a collapsible "how the agent thought" panel (judges like this).
- Tests: vitest, ≥10 tests, all against the mock client (distance mapping, exclusion, refill, explanation rendering).
- Deploy target: Render free web service (or Fly). Add `render.yaml`, `Dockerfile`, `.env.example` (QLOO_API_KEY, OPENAI_API_KEY, OPENAI_MODEL, PORT). `npm start` runs it.
- License MIT. README in English: what/why (quotes above), quick start, architecture, "why Qloo is load-bearing" section, screenshots placeholder.

## Design
- Dark, warm. Cards in a 2-column grid on desktop, 1 column on phone. Each card: title, type chip, "because of" chips (your inputs that pulled it), distance badge, one-liner, "already know it" button.
- The distance slider has three labelled stops: "Next door", "Across town", "Out of the bubble".
- Empty state shows three example prompts users can click (e.g. "Blade Runner 2049 + The Left Hand of Darkness + Disco Elysium → artists").

## Forbidden
- No tokens or keys in repo. No Qloo response data in repo. No React. No Twitch/sitwithme code reuse beyond general patterns.
- Don't write outside this repo directory.

## Delivery order (continuous, no "day" planning)
1. Scaffold + mock client + agent loop + API routes (`POST /api/resolve`, `POST /api/discover`, `POST /api/exclude`) + tests green.
2. UI single page wired to API, works in mock mode, looks finished.
3. README, Dockerfile, render.yaml, .env.example, LICENSE.
4. Stop and report: file list, `npm test` output, how to switch to the real key.
