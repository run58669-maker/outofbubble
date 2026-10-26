# Visual fidelity ledger

Reference: `docs/design/out-of-the-bubble-concept.png`  
Verified render: 1440 × 1000 desktop and 390 × 844 mobile, captured from `http://localhost:3000`.

| Comparison point | Concept evidence | Render evidence | Resolution |
|---|---|---|---|
| First-viewport composition | Quiet masthead, wide composer, result heading, two-column results | Same sequence and proportions fit the 1440 × 1000 viewport; the fourth row begins below the fold because production returns eight cards | Faithful; the concept intentionally showed six representative cards while the work order requires 8–10 |
| Palette and atmosphere | Near-black plum surface, parchment type, coral action, lilac controls, faint orbit paths | Render uses the same locked color families and subtle orbit-line background without adding a tint over artwork | No material mismatch |
| Typography | Editorial serif for brand/headings/card copy; restrained sans for controls and metadata | Fraunces/DM Sans with Georgia/Segoe fallbacks preserve the hierarchy and deliberate control sizing | No material mismatch |
| Composer controls | Removable interests, target category, three-stop distance, one coral action | All controls are code-native and interactive; the production input stays open for a fourth or fifth interest | Small intentional functional extension |
| Card anatomy | Square editorial art, title/type/distance, two cause chips, explanation, outlined known-item action | Production cards match the anatomy and use ten distinct generated atlas cells; initial eight cards do not repeat artwork | No material mismatch |
| Agent trace | Integrated bottom panel with Resolve → Discover → Explain | Collapsible semantic `details` panel mirrors the structure and adds a fourth Refill step only after exclusion | Intentional state-specific extension |
| Responsive behavior | Desktop two-column system with implied phone continuation | 390 px capture shows a strict one-column stack, 390 px body width, no horizontal overflow, and full-width primary actions | No material mismatch |
| Motion and states | Clear interactive affordances and restrained motion cues | Hover/focus, skeleton loading, departure/refill, toast, and reduced-motion handling are present | No material mismatch |
| Render cold start | Not shown in the original static concept | A compact warm-bordered status row appears after 3 seconds, retains the existing palette, and becomes an inline retry action at 25 seconds | Required production state; no layout regression |
| Default demo disclosure | The concept uses fictional seeded results | A small `Demo run — try your own` control now labels the automatic result set and returns focus to the composer | Required clarity improvement |

## Above-the-fold copy diff

All concept-locked product copy is preserved: brand, tagline, composer title, the three sample interests, target label/value, distance label/stops, primary action, result heading, type, distance, cause labels, and known-item action.

Intentional production additions are `Start over`, the `3 of 5` counter, input help text, the result count sentence, preview/live status, the explicit demo control, and request-state feedback. They support the required empty-state path, 3–5 input constraint, cold-start recovery, and transparent mock/live state without changing the product story. No hero eyebrow, marketing claim, or unrelated section was added.

## Interaction verification

The automated browser path loaded eight mock cards, excluded `Velvet Calculus`, observed a fresh replacement while card count remained eight, verified the visible Refill trace, opened the required three-example empty state, and checked the mobile stack. Browser console errors and warnings: zero.
