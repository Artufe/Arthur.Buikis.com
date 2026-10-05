# /play: the games, shown as agentic-coding work

**Status:** design approved in brainstorming (visual aides v1–v2), spec pending review
**Date:** 2026-10-04

## Goal

The two in-site games (Snake and GOLDENLINE) are reachable today only from the command palette.
Give them a visible home that also shows *how* they were built, as evidence of agentic AI coding
work:

- A short **"Play" strip on the home page**, between Selected work and Currently.
- A standalone **`/play` page**: the games in a grid, a build receipt under each, and a shared
  "How these were built" block.

Clicking a game opens its own route (`/snake/`, `/surf/`) in the same tab, not the floating window.
The palette easter eggs stay as they are.

**Audience:** people evaluating Arthur (hiring managers, engineers). The page should read as
"here is how I work with agents", backed by links to the real PRs and agent task lists, not as
"here are some toys".

## Facts (source of every claim on the page)

| Claim | Value | Source |
|---|---|---|
| Model (both) | Claude Opus 5.5 | Arthur |
| Snake mode | one-shot upgrade, single agent, "a benchmark of sorts for the new model" | Arthur |
| Snake time | 40 minutes | Arthur |
| Snake code | ~4.5k lines TS, 11 spec files | repo (`components/snake/`) |
| Snake critic loop | fresh critic agent scored 36 screenshots per round: 6 → 7 → 7.5 / 10 | PR #43 description |
| GOLDENLINE mode | 1 orchestrator + 10 agents, 2 phases, ≤ 6 in parallel | Arthur + `docs/goldenline/TASKS.md` |
| GOLDENLINE time | 2 evenings | Arthur |
| GOLDENLINE code | ~31k lines TS, three.js WebGPU + TSL | repo (`components/goldenline/`) |
| Arthur's part | wrote the initial prompt · specified the details to focus on · defined the agent tasks · reviewed and playtested | Arthur |
| LITTLEBIG (added 2026-10-05) | third game: a tiny cartoon planet, orbit → dive through the clouds → street-level walk; procedural, zero asset downloads; three.js WebGL (runs on phones and Safari); touch ok; route `/planet/` | orchestrator brief |
| LITTLEBIG mode | one prompt from Arthur, run as a multi-agent harness: the orchestrator wrote `docs/littlebig/BRIEF.md` and `TASKS.md`, then ran 11 builder tasks in 4 phases (F0 → A1-A4 → B1-B4 → C1-C2), ≤ 4 agents at once | orchestrator + `docs/littlebig/TASKS.md` |
| LITTLEBIG review | a fresh critic per build scored screenshots at each altitude; under 8.5 / 10 → refine round (all 8 world/life builds did); gate reviews between phases through three lenses (art & wow, life & flow, perf & size), owners fixed what they found | orchestrator |
| LITTLEBIG time | 17 hours wall clock, overnight (Oct 4 15:02 → Oct 5 ~08:30 EEST), including two usage-limit pauses | orchestrator |
| LITTLEBIG code | ~30k lines TS, 23 spec files | repo (`components/littlebig/`) |
| Arthur's part (LITTLEBIG) | wrote the prompt, set the constraints (≤ 4 agents at once, quality first, small and fast), reviewed. He did **not** write the brief or define the agent tasks for LITTLEBIG. | Arthur, via the orchestrator |

**Off-limits:** cost, token counts, restarts. **Cut by choice:** the "what went wrong" (failed M3
gate) callout. The pipeline diagram shows the gates neutrally, with no ✗.

## Settled decisions

- Route `/play`, nav label **Play** (after Building), palette command `goto play`.
- Proof = **receipt per game + one shared method block**. No hero stats row.
- Card: media links straight to the game. The overlay (with a `$ ./<game> --about` line) shows on
  hover / keyboard focus. On touch screens a compact caption band is always visible and one tap
  opens the game. A requirements chip is always visible.
- Receipt sits **below** the card, outside the link (nested links aren't valid), always visible.
- **Clips autoplay from page load**, muted and looping, on desktop **and mobile**. Each starts once
  it's near the viewport and pauses off screen or in a hidden tab. Reduced motion shows the still
  only. A small pause/play toggle sits on every clip (WCAG 2.2.2).
- Images are **clean**: no baked-in text.
- GOLDENLINE: cover still = pier with a breaking barrel (`gl-pier-break.jpg`, main). Clip = a
  **three-scene trailer, crash → ride → ashore**, about 4.5 s each, joined by short crossfades and
  looping seamlessly back to the crash.
  - **Crash:** the wave pitching with the pier on the horizon.
  - **Ride:** the surfer on the face, gliding down the line.
  - **Ashore:** the swash running up beside the pier and draining back.
  - Every scene has a **slow, continuous camera move** (a truck, pan or push-in) rather than a
    locked-off camera.
- Snake: gets theme-matched clips (dark and light), so both cards move. Its camera is the game's
  own follow camera, which already pans with the snake.

## Page anatomy

### Home strip, `components/play-teaser.tsx`

Same frame as the other home sections (`mx-auto max-w-[1600px] px-6 py-20 lg:px-16 lg:py-28`,
2px top border, `ScrollReveal`), with a `lg:grid-cols-[1fr_2.5fr]` grid.

- **Left column:**
  - `$ ls ~/play` prompt label (accent `$`).
  - h2 *"Two games, built with agents."*
  - Pitch: *"A 40-minute one-shot and a two-evening, eleven-agent build. Both run in your browser."*
  - Small mono note: *"Claude Opus 5.5 · code / me · prompts, tasks, review"*.
- **Right column:**
  - Two 16:10 tiles, each a link to its game, with the clip playing.
  - A mono caption under each (`snake · three.js · 3d · 40 min · one-shot`;
    `goldenline · webgpu · tsl · 2 evenings · 11 agents`).
  - The dashed-border link `[ how they were built · /play → ]`.
- No overlays and no receipts on the home page.

### `/play`, `app/play/page.tsx`

1. **Hero:**
   - `$ ls -la ~/play` label.
   - h1 *"Two games, built with agents."*
   - Intro: *"Both run right here in the browser. Claude Opus 5.5 wrote the code. I wrote the prompts,
     chose what to focus on, split the work into agent tasks, then reviewed and playtested."*
2. **Grid:**
   - `grid-cols-1 lg:grid-cols-2`. A third game is just another entry in `content/play.ts`.
   - Each entry: an index row (`01 · snake` … `pr #43 · sep 2026`), the card, then the receipt.
3. **Card** (a link to the game, same tab):
   - Poster still, with the clip layered above it.
   - Chip, top left:
     - Snake: `● touch ok` (green dot).
     - GOLDENLINE: `● desktop · webgpu · keyboard` (amber dot); on narrow screens `desktop · webgpu`.
   - Overlay on hover or keyboard focus:
     - `$ ./snake --about`
     - Display-font title.
     - One-line description.
     - The route path, plus a `▶ play` button (`▶ open` for GOLDENLINE on touch screens).
   - The overlay gradient keeps the top ~35% of the clip visible.
   - On hover: accent border, 4% image zoom, overlay content rises 10px.
   - Under `(hover: none)`: a caption band only (title, description, button), with no `$` line and no path.
4. **Receipt:** a `dl` in 3 columns (2 on mobile, which drops the Model and Tests/Engine rows):
   - Snake: Model · Mode `one-shot · 1 agent` · Time `40 min` · Code `~4.5k lines ts` ·
     Tests `11 spec files` · Source `PR #43 ↗`
   - GOLDENLINE: Model · Mode `1 orchestrator + 10 agents` · Time `2 evenings` ·
     Code `~31k lines ts` · Engine `three.js webgpu · tsl` · Source `PR #44 ↗`
5. **Method block** (`$ cat HOW-IT-WAS-BUILT.md`, h2 *"How these were built."*, two columns):
   - **01 · one-shot**, *"Snake: one prompt, forty minutes."*
     - Copy: "A benchmark of sorts for a new model. Claude Opus 5.5 rebuilt the old 2D snake as a 3D
       game from a single prompt, natively, with no orchestration."
     - Chain: `prompt → spec → plan → build → critic ×3 → PR #43`.
     - Critic-scores line.
   - **02 · orchestrated**, *"GOLDENLINE: one orchestrator, ten agents."*
     - Copy: "I wrote the brief and defined the agent tasks. The orchestrator built the shared core
       and contracts, then ran the agents in two phases. Each agent owned one system and ran its own
       review loop."
     - CSS pipeline diagram:
       - brief → orchestrator (core · contracts · review tooling · integration)
       - Phase A, parallel, ≤ 6 at once: A1 atmosphere + post, A3 beach & sand, A4 pier,
         A5 surface state, A6 first-person player, and the chain A2 ocean → A7 water shading →
         A8 breaking waves
       - review gates (M2 beauty shot · M3 waves in motion) → look pass
       - Phase B: B1 surfing, B2 polish · perf · startup
       - final review → PR #44
     - It stacks to one column on mobile.
   - **My part:** a 4-cell numbered row with Arthur's four steps.
   - **Source links** (external, `target="_blank" rel="noreferrer"`): BRIEF.md, TASKS.md,
     DECISIONS.md, the snake spec, PR #43, PR #44 on `github.com/Artufe/Arthur.Buikis.com`.

The page keeps the hero shader (not added to `SHADER_EXCLUDED_ROUTES`).

## Components and data

| Unit | Kind | Responsibility |
|---|---|---|
| `content/play.ts` | data | `games: PlayGame[]` and `method`, typed. Single source for the teaser, the page and `llms.txt`. |
| `components/play/game-clip.tsx` | client | Poster `<img>` plus muted looping `<video>`. In-view autoplay, off-screen/hidden-tab pause, a sticky manual toggle, and reduced motion means poster only. |
| `components/play/game-card.tsx` | server | Index row, card link (chip + overlay + `GameClip`), receipt `dl`. |
| `components/play/play-method.tsx` | server | The method block, pipeline diagram and source links. |
| `components/play-teaser.tsx` | server | Home strip. Reuses `GameClip`. |
| `app/play/page.tsx` | route | Hero, grid, method. `metadata` follows `app/building/page.tsx`. |

```ts
type PlayMedia = { poster: string; video: string; alt: string };
type PlayGame = {
  slug: 'snake' | 'goldenline';
  title: string;            // 'Snake' | 'GOLDENLINE'
  href: '/snake/' | '/surf/';
  cmd: string;              // './snake --about'
  description: string;      // overlay copy
  chip: { label: string; short?: string; tone: 'ok' | 'warn' };
  media: PlayMedia;          // default (dark theme, or the only variant)
  lightMedia?: PlayMedia;    // present → swapped in under the light theme
  caption: string[];        // home-strip caption parts
  receipt: { label: string; value: string; href?: string; desktopOnly?: boolean }[]; // desktopOnly rows hide below 640px
  pr: { number: number; date: string };            // index row
};
```

**`GameClip` behaviour:**
- Renders `<video muted loop playsInline preload="none" aria-hidden>` with no `src` until an
  `IntersectionObserver` (rootMargin `200px`) reports it in view. Then it sets `src`, plays, and
  fades in on the first `playing` event.
- It pauses when out of view or when `document.hidden`. The toggle is a sibling of the card link,
  positioned top right, and a manual pause sticks. Its label flips between "Pause video" and
  "Play video", with no `aria-pressed`: a toggle whose name changes must not also report a pressed
  state.
- With `prefers-reduced-motion: reduce` there is no video at all: the poster `<img>` with its alt
  text stays.
- Theme-matched media (Snake) renders one `GameClip` per theme, wrapped in `.only-dark` /
  `.only-light`. These are two new rules in `globals.css` keyed on the `.dark` class: Tailwind's
  `dark:` variant follows the OS, not next-themes. The hidden variant is `display: none`, so the
  observer never reports it and it never downloads.

## Media assets (`public/play/`)

| File | Spec |
|---|---|
| `goldenline.jpg` | 1600×1000 cover (`gl-pier-break.jpg`, main), ≤ 300 KB |
| `goldenline.mp4` | trailer (crash → ride → ashore), 1280×800, 30 fps, 15 s, H.264 yuv420p `+faststart`, ≤ 6 MB (budget raised for the ride's spray; ~5.9 MB, denoised before encoding) |
| `snake-dark.jpg` / `snake-light.jpg` | 1600×1000 posters, ~285 KB |
| `snake-dark.mp4` / `snake-light.mp4` | 1280×800, 30 fps, 9 s, seamless loop (0.6 s dissolve), ~1.8 MB each |

- **MP4 only.** H.264 plays everywhere, including iOS. The VP9 WebMs came out the same size, so a
  second source adds weight to the repo without saving bandwidth. That's about 10.4 MB of committed
  media.
- Frames are rendered deterministically:
  - **GOLDENLINE** through its shot tool's `__goldenline` hooks: free camera, `setTime`, `step`.
    Each scene is 165 frames: 135 core frames plus 15-frame handles at each end for the crossfades.
    The camera keyframes are interpolated per frame.
  - **Snake** by freezing the live renderer and stepping the real pure engine at 60 Hz. A scripted
    autopilot steers it, and a seed planner picks a window (seed 246, sim time 18–27 s) with three
    eats, including a golden. Both themes follow the identical path.
- The capture helpers move from the gitignored `.superpowers/tmp/` into `scripts/play-media/`. The
  recipe (cameras, times, seeds, ffmpeg) goes in `docs/play-media.md`, so the clips can be
  regenerated when the games change.

## Wiring

- `content/site.ts` `nav`: `{ label: 'Play', href: '/play' }` after Building. The nav, mobile nav
  and footer all read it.
- `lib/commands.ts`: `goto-play` (Navigate, hint `/play`, keywords `games`, `snake`, `surf`).
- `app/sitemap.ts`: add `/play/` to `STATIC_ROUTES`.
- `app/llms.txt/route.ts` and `app/llms-full.txt/route.ts`: a Pages line for `/play/`
  ("two browser games built with coding agents").
- `app/page.tsx`: `<PlayTeaser />` between `<FeaturedWork />` and `<BuildingTeaser />`.

## Accessibility

- Card link `aria-label="Play Snake"` / `"Play GOLDENLINE"`. The overlay is visible on
  `:focus-visible`, not only `:hover`.
- Poster alt text describes the scene. The video is `aria-hidden`, since it's decorative and the
  poster carries the meaning.
- The pause toggle is a real `<button>` outside the link and is keyboard-reachable.
- Reduced motion: no video, no zoom transition. The global CSS caps transitions too.

## Testing

- **vitest:**
  - `tests/content/play.test.ts`: the data's shape and links. `tests/content/play-media.test.ts`:
    every referenced media file exists and is within budget.
  - `tests/app/play-page.test.tsx`: every game in `content/play.ts` renders a link to its `href`.
    Receipts render every row. PR and doc links are external (`target=_blank`, `rel=noreferrer`).
    The chips render.
  - `tests/components/game-clip.test.tsx`, with `IntersectionObserver`, `matchMedia` and
    `HTMLMediaElement.play/pause` mocked:
    - No `src` before intersecting.
    - `src` is set and `play()` called on intersect.
    - It pauses on leaving view and on a hidden tab.
    - A manual pause survives re-entering view.
    - Reduced motion renders no `<video>`.
  - `tests/components/play-teaser.test.tsx`: both tiles link to their games, and the `/play` link
    is present.
- **e2e (`tests/e2e/play.spec.ts`):** the nav's Play link loads `/play/` with two cards. The Snake
  card navigates to `/snake/`.
- `pnpm typecheck`, `pnpm test`, `pnpm build` green. Check `out/play/index.html` exists.
- **Visual check:** screenshot `/play` and the home strip in both themes at 1440 and 390 wide, and
  confirm the clips play.

## Branch

`play-page`, from `origin/master`, which is now pnpm 12 / Node 24 per #46. This worktree's
`node_modules` must be reinstalled first. PR `play-page` → `master`.

## Out of scope

- Other "lab" items. (A third game, LITTLEBIG, was added on 2026-10-05: an odd last card spans the
  grid at `lg` as a landscape card, the home strip shows three tiles, and the method block gains
  "03 · harnessed".)
- Changing either game.
- Fixing the lagoon "white slab" bore look the capture surfaced.
- An AV1 or mobile-specific encode.
- An OG image for `/play` (the site default applies).
