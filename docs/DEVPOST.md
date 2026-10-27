# Devpost submission draft: Out of the Bubble

> Status: final text. All numbers: live site `/api/discover` and `/api/resolve` (real Qloo key), 2026-10-27.

## Project name
Out of the Bubble

## Tagline (≤60 chars)
Your films, books and games pick your next obsession.

<!-- 53 chars. Alternate: "Let your favorite film choose your next band." (45) -->

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

The agent returns 10 ranked cards. Each card shows the recommendation, its category, and **"Because of …" chips naming which of your inputs pulled it in**. A **taste-bridge bar** above the grid counts how many cards each input pulled, and flags an input that needed an extra query (see below).

If you already know one, press **"I already know this."** The agent excludes it, along with everything currently on screen, and refills that slot with a new result. The **"How the agent thought"** panel shows each step: Resolve, Discover, Decide, Taste bridge, Explain, and each Refill appended below the run.

**A real run** (live site, 2026-10-27). Input: *Blade Runner 2049*, *The Left Hand of Darkness*, *Disco Elysium*. Target: artists.

| Distance | First results (Qloo order) | Mean popularity of the 10 results |
|---|---|---|
| Next door | Oneohtrix Point Never, Yves Tumor, Iglooghost, Against All Logic, Aphex Twin | 0.971 (range 0.882 to 0.999) |
| Across town | Daniel Lopatin, Hiroshi Yoshimura, Lingua Ignota, Spellling, Mid-Air Thief | 0.901 (range 0.611 to 0.955) |
| Out of the bubble | Rural Internet, Voyage Futur, Sofie Birch, Dear Laika, Argo Nuff | 0.405 (range 0.131 to 0.619) |

"Next door" and "Out of the bubble" share **0 of 10** results; neighboring stops share 1 of 10. Qloo credited the film and the game on all 10 cards and the book on none (re-measured once on 2026-10-27: *Blade Runner 2049* 10/10, *The Left Hand of Darkness* 0/10, *Disco Elysium* 10/10). That gap is what the taste bridge closes.

All three examples at all three stops. Each cell: cards with a Qloo explanation · mean popularity (range).

| Example → resolves to | Next door | Across town | Out of the bubble | Shared cards ND–AT / AT–OB / ND–OB |
|---|---|---|---|---|
| 01 → artists (movie, book, video_game) | 10/10 · 0.971 (0.882–0.999) | 10/10 · 0.901 (0.611–0.955) | 10/10 · 0.405 (0.131–0.619) | 1 / 1 / 0 |
| 02 → places in Kyoto (movie, book, brand) | 10/10 · 0.711 (0.449–0.989) | 10/10 · 0.631 (0.179–0.927) | 10/10 · 0.338 (0.013–0.550) | 7 / 5 / 4 |
| 03 → podcasts (video_game, place, book) | 10/10 · 0.983 (0.942–0.999) | 10/10 · 0.891 (0.718–0.959) | 10/10 · 0.510 (0.100–0.629) | 2 / 0 / 0 |

All nine runs logged "Decision: kept first query (10 results, 10/10 explained)", so the retry did not fire on these inputs. Kyoto places overlap more between stops: the city filter leaves a smaller pool.

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
- **Type-aware resolver:** `/search` runs with Qloo's `types` filter: only the hinted type when an input carries one, otherwise films, books, games, TV, artists, podcasts and brands, with localities and venues never allowed to win an unhinted input; an untyped search is the fallback and obeys the same rules. Each input shows the type it matched as a small chip, and clicking it lists the top three other Qloo matches so the user can switch.
- **Self-correction:** if fewer than 6 results came back or under half are explained, the agent retries once with one looser setting, keeps the better run, and logs a `Decision: … because …` line.
- **Taste bridge (the agent's real decision):** after the first insights call the agent counts how many cards cite each input through explainability. If an input is cited by none, it runs one extra `/v2/insights` call seeded with that input alone (same type and distance parameters, `take=4`, first-page IDs excluded), merges the new cards, and drops the lowest-affinity cards from the first page (never an input's only citation) so the page stays at 10. The trace logs `Decision: The Left Hand of Darkness was cited by 0 of 10 cards → ran one extra query seeded with it alone; merged N cards`, or `Decision: every input is represented (…)` when nothing is missing. On the live default example the book is cited 0/10, so the bridge runs.
- **Resolved-id reuse:** after the first run the browser sends each input back as `{id, name, type}`, so refills, slider moves and picker switches skip `/search` (the trace says "reused 3 resolved ids"). Fewer Qloo calls, and an input can't drift to a different entity mid-session.
- **Testing:** Vitest suite running against a deterministic mock Qloo client with hand-written fictional fixtures (no real Qloo data is stored in the repo). 46 tests in 4 files pass (`npm test`); the mock exercises both bridge branches.
- **Hosting:** Docker on Render (free tier), with a `render.yaml` blueprint. Because the free tier sleeps, the page detects slow cold starts, polls `/api/health`, and offers a retry instead of hanging.

## Why Qloo is load-bearing

Remove Qloo and nothing is left to recommend. The app has no catalog, no ratings, and no co-occurrence data of its own. Qloo does every step that matters: it turns "a film, a book and a game" into entities in one shared taste graph (`/search`), it turns those entities into a ranked set of artists, books, podcasts or places (`/v2/insights` with `signal.interests.entities`), it supplies the "because of" evidence (`feature.explainability`), it implements the comfort-zone slider (`bias.trends` and popularity filters), and it runs the refill loop (`filter.exclude.entities`). An LLM on its own could name "artists for fans of Blade Runner," but it can't show measured cross-category affinity or which of your inputs produced a result, and it would drift back toward the famous names this project exists to avoid. The optional LLM only writes a one-line hook over results Qloo already chose.

In the live run above, the three distance settings return nearly disjoint sets of 10 artists from the same inputs, and mean popularity drops from 0.971 to 0.405: Qloo's popularity and trend signals doing the work, not prompt wording. (I ran no head-to-head against a plain LLM, so I make no claim about one.)

## Challenges I ran into

- **Building before the API key arrived.** One `QlooClient` interface with a mock client (clearly fictional fixtures) and an HTTP client let the whole product be built and tested while I waited for the key.
- **Making "distance from your comfort zone" concrete.** A slider means nothing unless it maps to real parameters, so each stop is a fixed combination of `bias.trends` and popularity bounds (Out of the bubble: `bias.trends=low` + `filter.popularity.max=0.65`). Result-set overlap is 0 of 10 between the two ends.
- **Cold starts on a free host.** The first request after idle can take 50+ seconds. Rather than show a frozen page, the UI shows a wake-up notice, polls health, and offers a retry after a 65-second client timeout.
- **Real responses differed from my assumptions.** (0) My first resolver took names at face value: *Nausicaa*, *Braiding Sweetgrass* and *Patagonia* all resolved to towns, and *Hades* to a black-metal band. The fix is the type-aware resolver above. Unhinted, *Hadestown* resolves to a book; the example pins the Broadway production (a place entity). (1) `/v2/insights` silently ignored the `limit=8` I first sent and returned its default page of 20; the API pages with `take`, which is what the client sends now; (2) `/search` returns fuzzy hits even for nonsense, so taking the first hit turned made-up names into unrelated entities; (3) Qloo returns exactly two explainability sources per card, with scores that sum to 1. In 90 live cards (3 examples × 3 stops) the third input was never cited: *The Left Hand of Darkness*, *Nausicaa* and *Hadestown* resolve to the right entities but appear on 0 cards. The app shows every source Qloo returns, so this is Qloo's choice, not a display cut; it is why the taste bridge exists; (4) an artist can be a collaboration entity (for example "Ape Escape,Soichi Terada").

## Accomplishments that I'm proud of

- Each card says **why** it's there, in terms of the user's own inputs. Explanation isn't an afterthought.
- The comfort-zone slider is a real control backed by Qloo parameters, not a decorative label.
- The "I already know this" loop. Telling the agent what you already know immediately produces something new.
- The Qloo key stays server-side, no personal data is sent (only entity names and IDs), and no Qloo responses are committed.

## What I learned

- Cross-category signals are the interesting part. A recommendation for music reached through a book says something a music-only recommender can't.
- Explainability changes how a recommendation feels. "Because of *Disco Elysium*" makes an unfamiliar name worth a click.
- Inputs are not equally influential. Qloo names two sources per card, and one input can be shut out entirely; measuring that became the taste bridge.
- Verify every API parameter against what comes back. Qloo silently ignored `limit` (only counting the cards exposed it), and `/search`'s first hit is often wrong, so the resolver matches by type and name, and the agent refuses to run when no input matched a real entity.

## What's next

- Show explainability strength per source as a small bar on each "because of" chip, not only in the tooltip.
- Let users list things they already know up front (seed `filter.exclude.entities`) instead of only rejecting cards one at a time.
- "Open in…" links on each card (streaming / bookstore / map) so a discovery is one click from being tried.
- A shareable link for a constellation, so friends can see where your taste leads.

## Built with
`typescript` `node.js` `express` `qloo` `qloo-insights-api` `esbuild` `vitest` `html5` `css3` `docker` `render` `openai` (optional hook)

## Try it out
- Live demo: https://outofbubble.onrender.com (free Render tier: the first request after idle can take about a minute; the page shows a wake-up notice)
- Source: https://github.com/run58669-maker/outofbubble (MIT)
