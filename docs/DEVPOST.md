# Devpost submission draft: Out of the Bubble

> Status: final text. All numbers: live site `/api/discover` (real Qloo key), measured 2026-10-27; the table's ‡ note says which commit each cell ran on.

## Project name
Out of the Bubble

## Tagline (≤60 chars)
Your films, books and games pick your next obsession.


## Inspiration

Recommendation feeds are very good at giving me more of what I already have. People keep saying the same thing in public:

> "my Spotify recommendation algorithm complaint is about the exact opposite, that it’s too conservative in what it suggests. Sometimes I feel stuck in a musical “echo chamber.”"
> (Hacker News, September 2026: https://news.ycombinator.com/item?id=49797896)

> "Recommendations have gotten noticeably worse since the glory days of Discover Weekly."
> (Hacker News, August 2026: https://news.ycombinator.com/item?id=49173215)

> "I often open Spotify or YouTube intending to find something unfamiliar, but recommendations lead me back to the same artists, genres, and moods."
> (r/indieheads, June 2026: https://reddit.com/r/indieheads/comments/1ubrp0p/)

Most recommenders only look inside one category. If you only listen to music, a music recommender only has your music history to work with, so it hands you the nearest neighbor. But taste doesn't stop at a category boundary. The person who loves *Blade Runner 2049*, *The Left Hand of Darkness* and *Disco Elysium* has a recognizable sensibility, and that sensibility has a soundtrack they've never heard. I wanted an agent that uses everything you love to send you somewhere new, and then tells you why it went there.

## What it does

You give it 3 to 5 things you love, from any category: a film, a book, a game, a brand, a place. You pick what you want to discover next (artists, books, podcasts, movies, TV shows, video games, or places in a city) and how far from your comfort zone to go:

- **Next door**: close, well-known neighbors of your taste
- **Across town**: less obvious and more varied
- **Out of the bubble**: low-popularity, low-trend results you're unlikely to have met

The agent returns 10 ranked cards. Each card shows the recommendation, its category, and **"Because of …" chips naming which of your inputs pulled it in**. A **taste-bridge bar** above the grid counts, per input, the cards Qloo cited it on and, separately, the cards the agent seeded from it (see below).

If you already know one, press **"I already know this."** The agent excludes it, along with everything currently on screen, and refills that slot with a new result. Known items stay excluded across re-runs (slider moves, match switches, refills); only Start over or a different set of inputs clears them. The **"How the agent thought"** panel shows each step: Resolve, Discover, Decide, Taste bridge, Explain, and each Refill appended below the run.

**Measured 2026-10-27 on the live site** (one `/api/discover` call per cell, real Qloo key). Default example: *Blade Runner 2049*, *The Left Hand of Darkness*, *Disco Elysium* → artists; examples 02 (Nausicaa, Braiding Sweetgrass, Patagonia → places in Kyoto) and 03 (Hades, Hadestown, Circe → podcasts) at Out of the bubble. Cited = cards on which Qloo's explainability names the input; seeded cards are not counted as cited.

| Cell | Results | Cited (per input, in order) | Taste bridge | Explained | Mean popularity (range) |
|---|---|---|---|---|---|
| 01 Next door ‡ | 10 | 9 / 0 / 9 | book: 8 candidates, 1 passed, 1 merged | 9/10 | 0.952 (0.772–0.999) |
| 01 Across town ‡ | 10 | 9 / 0 / 9 | book: 8 candidates, 1 passed, 1 merged | 9/10 | 0.884 (0.611–0.955) |
| 01 Out of the bubble | 10 | 10 / 0 / 10 | book: 8 candidates, 0 passed, 0 merged, kept first query | 10/10 | 0.405 (0.131–0.619) |
| 02 Out of the bubble ‡ | 10 | 0 / 7 / 7 | film: 8 candidates, 6 passed, 3 merged | 7/10 | 0.344 (0.013–0.550) |
| 03 Out of the bubble ‡ | 10 | 10 / 0 / 10 | Hadestown: 8 candidates, 0 passed, 0 merged, kept first query | 10/10 | 0.510 (0.100–0.629) |

‡ Measured at 18:07 JST on commit 756fa3b (gate: ≥ 2 tags shared with the other inputs); the live site moved to cad21e7 (stricter gate, text below) at about 18:15 and the cells without ‡ were measured on it. Pass counts on ‡ cells are therefore the looser gate's and are to be re-measured. In every cell Decide logged "kept first query (10 results, 10/10 explained)" before the bridge ran. The same default cell returned 1 passed at 18:06 and 0 passed at 18:17 (different gates and a refreshed Qloo pool), so a bridge outcome is not stable run to run.

Each card's popularity badge uses fixed thresholds on Qloo popularity: "well known" from 0.85, "familiar" from 0.6 to 0.85, "deep cut" below 0.6. The far-out cap (0.65) sits below the "well known" floor, so an Out-of-the-bubble card can never be labelled "well known".

## How I built it

- **Server:** Node.js 20 + TypeScript, Express. One process serves the API (`/api/resolve`, `/api/discover`, `/api/exclude`) and the compiled front end.
- **Agent loop** (`server/src/agent.ts`): Resolve → Discover → Decide → Taste bridge → Explain, plus Refill on "I already know this" (these are the trace step names). Every step writes to an in-memory trace that the UI renders.
- **Qloo integration** (`server/src/http-qloo-client.ts`), server-side only, `X-Api-Key` header, `https://hackathon.api.qloo.com`:
  - `GET /search` resolves free-text names from any category into Qloo entity IDs.
  - `GET /v2/insights` with `filter.type=urn:entity:<target>` and `signal.interests.entities=<the resolved IDs>`: the user's cross-category taste becomes the signal for a different target category.
  - The discovery-distance slider is translated into Qloo controls: `bias.trends` (high/low) and `filter.popularity.min/max`.
  - `take=10` sets the page size.
  - `feature.explainability=true` supplies the "Because of …" sources on each card: every source Qloo names, strongest first, with the score in the chip's tooltip.
  - `filter.exclude.entities` powers the "I already know this" refill. The request is stateless: the browser sends the known ID plus the IDs already on screen.
  - `filter.location.query` scopes place discovery to a city.
- **LLM (optional):** an OpenAI Responses API call can add a one-line hook per card. It never selects, ranks or explains anything. It is switched off on the live demo, so every card shows Qloo's own description and explainability only.
- **Front end:** a single static HTML page with a small amount of vanilla TypeScript bundled by esbuild. No framework, no canvas. Two-column card grid on desktop, one column on phones; motion respects `prefers-reduced-motion`.
- **Type-aware resolver:** `/search` runs with Qloo's `types` filter: only the hinted type when an input carries one, otherwise films, books, games, TV, albums, artists, podcasts and brands, with localities and venues never allowed to win an unhinted input; an untyped search is the fallback and obeys the same rules. Each input shows the type it matched as a small chip, and clicking it lists the top three other Qloo matches so the user can switch; the typed text stays, and the chip reads "typed → matched · type".
- **Self-correction:** if fewer than 6 results came back or under half are explained, the agent retries once with one looser setting, keeps the better run, and logs a `Decision: … because …` line.
- **Taste bridge (the agent's real decision):** the agent counts how many cards cite each input through explainability. If an input is cited by none, one extra `/v2/insights` call seeded with that input alone (same type and distance, `take=8`, first-page IDs excluded) builds a *candidate pool*, not results. A candidate passes only if it shares ≥ 1 Qloo tag with the seed itself *and* ≥ 2 tags with your *other* inputs' tags (ranked by the latter, then seed tags, then affinity); at most 3 merge, each replacing the lowest-affinity first-page card that is not an input's only citation. If none pass, nothing merges. The trace prints every number: `… 2 passed the relevance gate (seed ≥ 1 and others ≥ 2 of 322: "Alryk": seed 2 · others 9/322 (min 2), …); merged 2, replaced 2`, or `… 0 passed …; kept first query`. A merged card says "Seeded from …" with its shared tags, carries no Qloo score, and the bar counts it as *seeded*, never as *cited*: `The Left Hand of Darkness · 0 cited · 2 seeded`.
- **Resolved-id reuse:** after the first run the browser sends each input back as `{id, name, type}`, so refills, slider moves and picker switches skip `/search` (the trace says "reused 3 resolved ids"). Fewer Qloo calls, and an input can't drift to a different entity mid-session.
- **Testing:** Vitest suite running against a deterministic mock Qloo client with hand-written fictional fixtures (no real Qloo data is stored in the repo). 62 tests in 6 files pass (`npm test`); the mock exercises both gate branches (passes / nothing passes).
- **Hosting:** Docker on Render (free tier), with a `render.yaml` blueprint. Because the free tier sleeps, the page detects slow cold starts, polls `/api/health`, and offers a retry instead of hanging.

## Why Qloo is load-bearing

Remove Qloo and nothing is left to recommend. The app has no catalog, no ratings, and no co-occurrence data of its own. Qloo does every step that matters: it turns "a film, a book and a game" into entities in one shared taste graph (`/search`), it turns those entities into a ranked set of artists, books, podcasts or places (`/v2/insights` with `signal.interests.entities`), it supplies the "because of" evidence (`feature.explainability`), it implements the comfort-zone slider (`bias.trends` and popularity filters), and it runs the refill loop (`filter.exclude.entities`). An LLM on its own could name "artists for fans of Blade Runner," but it can't show measured cross-category affinity or which of your inputs produced a result, and it would drift back toward the famous names this project exists to avoid. The optional LLM only writes a one-line hook over results Qloo already chose.

In the live runs above, mean popularity on the default example drops from 0.952 (Next door) to 0.884 (Across town) to 0.405 (Out of the bubble): Qloo's popularity and trend signals doing the work, not prompt wording. (I ran no head-to-head against a plain LLM, so I make no claim about one.)

## Challenges I ran into

- **Building before the API key arrived.** One `QlooClient` interface with a mock client (clearly fictional fixtures) and an HTTP client let the whole product be built and tested while I waited for the key.
- **Making "distance from your comfort zone" concrete.** A slider means nothing unless it maps to real parameters, so each stop is a fixed combination of `bias.trends` and popularity bounds (Out of the bubble: `bias.trends=low` + `filter.popularity.max=0.65`).
- **Cold starts on a free host.** The first request after idle can take 50+ seconds. The UI shows a wake-up notice, polls health, and offers a retry after 65 seconds.
- **Real responses differed from my assumptions.** (0) My first resolver took names at face value: *Nausicaa*, *Braiding Sweetgrass* and *Patagonia* all resolved to towns, and *Hades* to a black-metal band. The fix is the type-aware resolver above. Unhinted, *Hadestown* resolves to a book; the example pins the Broadway production (a place entity). (1) `/v2/insights` silently ignored the `limit=8` I first sent and returned its default page of 20; the API pages with `take`, which is what the client sends now; (2) `/search` returns fuzzy hits even for nonsense, so taking the first hit turned made-up names into unrelated entities; (3) how many inputs Qloo cites per card varies with the inputs: on the default example the film and the game are cited on every card and the book on none, while *Twin Peaks* + *Kind of Blue* + *Aesop* (as an artist) cited all three on every card. The app shows every source Qloo returns, so a shut-out input is Qloo's result, not a display cut; that is why the bridge checks for it on every run; (4) an artist can be a collaboration entity (for example "Ape Escape,Soichi Terada").

## Accomplishments that I'm proud of

- Each card says **why** it's there, in terms of the user's own inputs. Explanation isn't an afterthought.
- The comfort-zone slider is a real control backed by Qloo parameters, not a decorative label.
- The "I already know this" loop. Telling the agent what you already know immediately produces something new.
- The Qloo key stays server-side, no personal data is sent (only entity names and IDs), and no Qloo responses are committed.

## What I learned

- Cross-category signals are the interesting part. A recommendation for music reached through a book says something a music-only recommender can't.
- Explainability changes how a recommendation feels. "Because of *Disco Elysium*" makes an unfamiliar name worth a click.
- Inputs are not equally influential: one can be shut out entirely. Measuring that, without padding the page with off-taste cards, became the relevance-gated taste bridge.
- Verify every API parameter against what comes back. Qloo silently ignored `limit` (only counting the cards exposed it), and `/search`'s first hit is often wrong, so the resolver matches by type and name, and the agent refuses to run when no input matched a real entity.

## What's next

- Show explainability strength per source as a small bar on each "because of" chip, not only in the tooltip.

## Built with
`typescript` `node.js` `express` `qloo` `qloo-insights-api` `esbuild` `vitest` `html5` `css3` `docker` `render` `openai` (optional hook)

## Try it out
- Live demo: https://outofbubble.onrender.com (free Render tier: the first request after idle can take about a minute; the page shows a wake-up notice)
- Source: https://github.com/run58669-maker/outofbubble (MIT)
