# Devpost submission draft: Out of the Bubble

> Status: draft, 2026-10-27. The resolver, badge thresholds, far-out cap and decision step changed on 2026-10-27, so every number marked `<<MEASURE>>` must be re-measured on the live site's own `/api/discover` (real Qloo key, mode `http`) after the deploy. Numbers not marked come from earlier live calls and stay valid only if a re-measure confirms them.

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

The agent returns 10 ranked cards. Each card shows the recommendation, its category, and **"Because of …" chips naming which of your inputs pulled it in**, so you can see the bridge (for example, a musician reached through your book and your game rather than through any music you listed).

If you already know one, press **"I already know this."** The agent excludes it, along with everything currently on screen, and refills that slot with a new result. The **"How the agent thought"** panel shows each step of the run: Resolve, Discover, Decide, Explain, and Refill after an exclusion.

**A real run** (live site, <<MEASURE>> date). Input: *Blade Runner 2049*, *The Left Hand of Darkness*, *Disco Elysium*. Target: artists.

| Distance | First results (Qloo order) | Mean popularity of the 10 results |
|---|---|---|
| Next door | Oneohtrix Point Never, Yves Tumor, Iglooghost, Against All Logic, Aphex Twin | 0.971 (range 0.882 to 0.999) |
| Across town | Daniel Lopatin, Hiroshi Yoshimura, Lingua Ignota, Spellling, Mid-Air Thief | 0.901 (range 0.611 to 0.955) |
| Out of the bubble | <<MEASURE>> (cap is now 0.65) | <<MEASURE>> |

"Next door" and "Out of the bubble" share **<<MEASURE>> of 10** results; neighboring stops share <<MEASURE>> of 10. Cards carry Qloo explainability chips such as "Because of Disco Elysium". Explainability per example (cards with at least one source, at Out of the bubble):

| Example | Resolves to | Explained |
|---|---|---|
| 01 Blade Runner 2049 + The Left Hand of Darkness + Disco Elysium → artists | movie, book, video_game | <<MEASURE>>/10 |
| 02 Nausicaa + Braiding Sweetgrass + Patagonia → places in Kyoto | movie, book, brand | <<MEASURE>>/10 |
| 03 Hades + Hadestown + Circe → podcasts | video_game, place (the Broadway production), book | <<MEASURE>>/10 |

Each card's popularity badge uses fixed thresholds on Qloo popularity: "well known" from 0.85, "familiar" from 0.6 to 0.85, "deep cut" below 0.6. The far-out cap (0.65) sits below the "well known" floor, so an Out-of-the-bubble card can never be labelled "well known".

## How I built it

- **Server:** Node.js 20 + TypeScript, Express. One process serves the API (`/api/resolve`, `/api/discover`, `/api/exclude`) and the compiled front end.
- **Agent loop** (`server/src/agent.ts`): resolve → insights → explain → (on "I already know this") exclude + refill. Every step writes to an in-memory trace that the UI renders.
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
- **One real agent decision:** after the first insights call, if fewer than 6 results came back or under half are explained, the agent retries once with one looser setting (raise the popularity cap a notch, or drop `bias.trends`), keeps the better run, and writes a `Decision: … because …` line to the trace; otherwise it logs `Decision: kept first query (10 results, 10/10 explained)`.
- **Testing:** Vitest suite running against a deterministic mock Qloo client with hand-written fictional fixtures (no real Qloo data is stored in the repo). 36 tests in 3 files pass (`npm test`).
- **Hosting:** Docker on Render (free tier), with a `render.yaml` blueprint. Because the free tier sleeps, the page detects slow cold starts, polls `/api/health`, and offers a retry instead of hanging.

## Why Qloo is load-bearing

Remove Qloo and nothing is left to recommend. The app has no catalog, no ratings, and no co-occurrence data of its own. Qloo does every step that matters: it turns "a film, a book and a game" into entities in one shared taste graph (`/search`), it turns those entities into a ranked set of artists, books, podcasts or places (`/v2/insights` with `signal.interests.entities`), it supplies the "because of" evidence (`feature.explainability`), it implements the comfort-zone slider (`bias.trends` and popularity filters), and it runs the refill loop (`filter.exclude.entities`). An LLM on its own could name "artists for fans of Blade Runner," but it can't show measured cross-category affinity or which of your inputs produced a result, and it would drift back toward the famous names this project exists to avoid. The optional LLM only writes a one-line hook over results Qloo already chose.

In the live run above, the three distance settings return three nearly disjoint sets of 10 artists from the same three inputs (<<MEASURE>> shared between neighboring stops, <<MEASURE>> between the two ends), and the mean popularity of the result set drops from <<MEASURE>> to <<MEASURE>>. Those are Qloo's popularity and trend signals doing the work, not prompt wording. (I did not run a head-to-head against a plain LLM, so I make no claim about what one would suggest.)

## Challenges I ran into

- **Building before the API key arrived.** Hackathon keys are issued by hand. I designed one `QlooClient` interface with two implementations, a mock client backed by clearly fictional fixtures and an HTTP client for the real API, so the full product (UI, agent loop, refill, trace, deploy) could be built and tested while I waited.
- **Making "distance from your comfort zone" concrete.** A slider means nothing unless it maps to real parameters. I mapped each of the three stops to a specific combination of trend bias and popularity bounds. On the live API the three stops do produce different sets: `bias.trends=high` + `filter.popularity.min=0.24` for Next door; `bias.trends=low` + popularity between 0.08 and 0.96 for Across town; `bias.trends=low` + `filter.popularity.max=0.65` for Out of the bubble. Result-set overlap is <<MEASURE>> of 10 between the two ends.
- **Refill without sessions.** To keep the server stateless, every refill request carries the IDs already on screen, so the agent can exclude them all and return exactly one new card.
- **Cold starts on a free host.** The first request after idle can take 50+ seconds. Rather than show a frozen page, the UI shows a wake-up notice, polls health, and offers a retry after a client timeout.
- **Real responses differed from my assumptions.** (0) My first resolver took names at face value: *Nausicaa*, *Braiding Sweetgrass* and *Patagonia* all resolved to towns, and *Hades* to a black-metal band. The fix is the type-aware resolver above. (1) `/v2/insights` silently ignored the `limit=8` I first sent and returned its default page of 20; the API pages with `take`, which is what the client sends now; (2) `/search` returns fuzzy hits even for nonsense, so taking the first hit turned made-up names into unrelated entities; (3) the cards used to show at most two "Because of" sources, and with that cut *The Left Hand of Darkness* never appeared. With every source shown, it <<MEASURE: appears on N of 10 cards / still never appears>>; (4) an artist can be a collaboration entity (for example "Ape Escape,Soichi Terada").

## Accomplishments that I'm proud of

- Each card says **why** it's there, in terms of the user's own inputs. Explanation isn't an afterthought.
- The comfort-zone slider is a real control backed by Qloo parameters, not a decorative label.
- The "I already know this" loop. Telling the agent what you already know immediately produces something new.
- The full product was built and tested before the key arrived, then switched to the real API by setting one environment variable. The live site answered `/api/discover` in 3.1 to 3.4 s in three warm calls.
- The Qloo key stays server-side, no personal data is sent (only entity names and IDs), and no Qloo responses are committed.

## What I learned

- Cross-category signals are the interesting part. A recommendation for music reached through a book says something a music-only recommender can't.
- Explainability changes how a recommendation feels. "Because of *Disco Elysium*" makes an unfamiliar name worth a click.
- Designing the client interface first, and keeping fixtures clearly fake, kept the project honest and testable before real data existed.
- Real explainability data names the source entities with a score each. I first cut the list at two names, which hid part of the story; now every source is shown, strongest first, with the score on hover. Inputs are not equally influential: <<MEASURE: which inputs Qloo credits for example 01>>.
- Verify every API parameter against what comes back. Qloo silently ignored `limit` and returned 20 results; only counting the cards exposed it, and the fix was `take=10`. In the same pass I stopped trusting `/search`'s first hit: the resolver now searches by type, picks the hit whose name best matches the input, and counts a partial match only when the whole input appears inside the hit's name (so "Flimzap Nonexistent" no longer matches an album called "Nonexistent", and "Zzyzx Nonexistent Book" is reported as not found). If none of the inputs matches a real entity, the agent refuses to run: no insights call, no cards, and a clear message instead of "10 new paths".

## What's next

- Show explainability strength per source as a small bar on each "because of" chip, not only in the tooltip.
- Let users list things they already know up front (seed `filter.exclude.entities`) instead of only rejecting cards one at a time.
- Remember a user's picks from the match picker across sessions.
- "Open in…" links on each card (streaming / bookstore / map) so a discovery is one click from being tried.
- A shareable link for a constellation, so friends can see where your taste leads.

## Built with
`typescript` `node.js` `express` `qloo` `qloo-insights-api` `esbuild` `vitest` `html5` `css3` `docker` `render` `openai` (optional hook)

## Try it out
- Live demo: https://outofbubble.onrender.com (free Render tier: the first request after idle can take about a minute; the page shows a wake-up notice)
- Source: https://github.com/run58669-maker/outofbubble (MIT)
