# LITTLEBIG: performance

This file covers the budgets, how each is measured, where it stands and what is left. C2 wrote it in
phase 4 and the perf owner updated it in the final fix round.

All numbers come from the production build (`pnpm build`, `out/` served gzipped like GitHub Pages).
They were measured on the dev machine (Apple M3, Chromium headless, ANGLE/Metal). The GPU is
shared with other agents' browsers and the load average sat at 7–12 during these runs. Frame times
are therefore best-of runs, and differences under ~1 ms are noise.

## Budgets (BRIEF §1)

| Budget | Target | Now (final round) | |
|---|---|---|---|
| LITTLEBIG's own production JS (three excluded) | ≤ 150 KB gzip | 168.0 KB: engine 164.3 + canvas 2.7 + route 0.8 + loader 0.2 | **not met** (+18 KB) |
| Engine chunk → first frame, warm | ≤ 400 ms | 167 ms mark (median of 6, 162–184) | met |
| Engine chunk → first frame, cold | ≤ 400 ms | 475 ms mark (median of 6, 422–487) | **not met** |
| World complete, warm | ≤ 1.5 s | 0.67 s (median of 6, 0.59–0.80) | met |
| World complete, cold | ≤ 1.5 s | 1.58 s (median of 6, 1.48–1.66) | borderline |
| High, 1280×800, DPR 1: median frame | ≤ 12 ms | 8.2–13.9 ms net (table below) | **not met** over the city, at night, approach, landing |
| High on a retina screen (DPR 2 → capped 1.5) | (same) | 11–26 ms net in shot mode; the live loop steps resolution down | **not met** in shot mode |
| Scripted dive: no frame above median + 6 ms | 0 | high: 5 of 120 (median 16.8, max 27.0); low: 4 of 120 (10.8 / 19.9) | not met (serial harness: +3–6 ms) |
| Draw calls | ≤ 120 | 53–77 high, 56–67 low | met |
| Zero per-frame allocation | ~0 | 28–40 KB/frame production (final review), 13–23 KB of it ours | **not met** |
| No shader compiles after the reveal | 0 | 0 (final review: zero linkProgram calls over a real dive, walk and fly-to, and over 11 shots × 24 times of day) | met |
| Window open/close ×10, production | no leak | 9 engines tracked, 0 alive; listeners 49/147 before and after | met |
| Low tier holds 30 fps on a mid phone | 30 fps | CPU ×4 profile: 60 fps at every view (GPU not throttleable here) | met on CPU; GPU unverified |

## Measuring

`littlebig-shot.mjs` warns when other headless browsers are running. Use best-of runs
(`--perf F --reps N` gives `bestNet`) and paired A/B (`--ab`), and treat a single run as noise.
ANGLE/Metal timer queries return command-buffer latency, so there is no per-pass GPU split. Cost per
feature comes from paired toggles instead. Most toggles are `--p`; for the others, intercept
`generateMipmap` or `drawArrays` in an init script.

- **Size:** run `pnpm build`, serve `out/` (`cd out && python3 -m http.server 3099`), then
  `node scripts/littlebig-shot.mjs --bundle --url http://localhost:3099`. It lists the JS a
  `/planet/` visit loads that `/about/` does not, with three's two chunks labelled.
- **Boot:**
  - `--boot`: the marks, plus each stage-2 init's compile wait.
  - `--boot --cold`: unique shader sources, i.e. a first visit.
  - `shots/C2/bootraf.mjs`: what the screen did.
- **Frame time:**
  - `--shot … --perf 90 --reps 5 --size 1280x800 [--q low] [--dpr 2]`: serial CPU+GPU with a 1-px
    readback. `net` subtracts an empty-scene baseline of ~3 ms.
  - Shot mode keeps the resolution fixed. The live loop's adaptive resolution is off there.
  - `--dive 120 --perf 1`: per-frame cost along the descent. Without `--t` it starts the sim at
    `DIVE_T0`, the /play clip's start.
- **Allocation:** `shots/C2/alloc2.mjs` takes a sampling heap profile over 400 sim frames after a
  1500-frame warm-up. `shots/C2/gc.mjs` counts GCs on the live loop.
- **Leaks:** `--leak 10 --close-at 50,150,400,700,ready`. It loads `/?shot=1`, so it runs against a
  served `out/` too. Production is what matters: the minifier inlines across modules, which dev
  never does.
- **Pixel identity:** shoot the named shots before and after a change and diff them. Use the same
  shot list in the same order, because a dog's gait phase carries over between shots.

## Results

### Size (gzip −9, production, `--bundle`)

| | phase 4 HEAD | phase 4 end | final round |
|---|---|---|---|
| Engine chunk | 167.3 | 162.6 | 164.3 |
| Shared chunk (modules the debug chunk also imported) | 14.4 | none | none |
| Canvas wrapper (`littlebig-canvas.tsx`) | 2.6 | 2.6 | 2.7 |
| `/planet` route + debug loader | | 0.8 | 1.0 |
| **Production path** | **184.3** | **166.0** | **168.0** |
| Debug chunk (`?shot` / dev only) | 1.3 | 9.0 | 9.0 |

Three is another 81.5 + 83.0 KB gzip on top, shared with Snake. Brotli would bring the engine to
about 136 KB, but GitHub Pages serves gzip.

The final round added about 2 KB of features and fixes: the expand handoff, adaptive resolution,
the warm draw, the sea steer and portrait framing.

Where the engine's bytes go (phase-4 rolldown shares, still the right order):

| Part | KB |
|---|---|
| City render | 24 |
| World/city plan, graph and index | 21 |
| Nature | 19 |
| People | 17 |
| Camera | 14 |
| Traffic | 13 |
| Clouds | 10 |
| Air | 9 |
| Sky | 8 |
| Post | 6 |
| Terrain | 6 |
| Core | 5.5 |
| World | 5 |

GLSL is 129 literals, 76 KB raw and about 25 KB gzip, already comment- and whitespace-free. Code
outside string literals is 133 KB gzip.

Levers checked this round, and why they are not taken:

- **GLSL identifier renaming:** a prototype saves 0.5 KB gzip (24.3 → 23.8 KB over every tagged
  literal), against the risk of breaking three's chunk hooks.
- **Param labels:** 0.6 KB.
- **Untagged GLSL:** 2 literals, 0.2 KB.

The remaining 18 KB can only come from cutting features (the shares above), or from re-baselining
again in DECISIONS. That is the orchestrator's call.

### Frame time (production, best-of-3 × 60 frames, net ms, two passes, min shown)

| Shot | high 1280×800 DPR 1 | low 1280×800 DPR 1 | high 1280×800 DPR 2 (→ 1.5) | high 1512×945 DPR 2 (→ 1.5, full viewport) |
|---|---|---|---|---|
| orbit | 10.8 | 5.6 | 19.6 | 21.7 |
| city | 13.9 | 7.7 | 20.8 | 25.7 |
| clouds | 9.1 | 6.5 | 14.7 | 20.1 |
| rooftops | 9.7 | 7.2 | 15.9 | 19.9 |
| street | 8.2 | 8.0 | 16.9 | 19.8 |
| horizon | 8.8 | 5.7 | 11.2 | 15.1 |
| night | 13.0 | 7.4 | 17.6 | 22.5 |
| approach | 13.2 | 7.1 | 19.8 | 22.9 |
| landing | 13.0 | 7.5 | 19.2 | 21.5 |
| cloudscape | 8.8 | 6.8 | 13.9 | 17.5 |
| dusk | 11.5 | 6.8 | 15.1 | 18.2 |

- **DPR 1 vs half the pixels.** Halving the pixels (640×400) barely moves the high tier at orbit
  (12.3 vs 12.4 ms). At DPR 1, high is not fill-bound. Its fixed costs are the post chain and the
  2048² shadow map.
- **Above DPR 1.** Frame cost grows with pixels: DPR 1.5 adds 6–12 ms.
- **Post chain split.** Paired toggles at orbit / city, high, DPR 1:
  - post chain total: 6.7–7.7 ms
  - night bloom: 3–4 ms
  - shadow map: 2–3 ms
  - FXAA: ~1 ms
- **Retina screens.** `high` caps DPR at 1.5, and the live loop steps down 1.5 → 1.25 → 1 → 0.85
  when frames are missed (`core/engine.ts`, game owner). The DPR 2 columns are shot mode, where that
  is off. They are the worst case, not what a player sees.
- **Low tier.** Low lost the night bloom this round. Orbit went from 11.6 to 5.6–7.2 ms, night from
  11.2 to 7.4, and the dive median from 15.6 to 10.8 ms.

### Boot (production, `--boot`, 1280×800, medians of 6)

| | phase 4 HEAD | phase 4 end | final round (spread) |
|---|---|---|---|
| Warm: first-frame mark | 182 ms | 169 ms | 167 ms (162–184) |
| Warm: world complete | 714 ms | 576 ms | 667 ms (586–796) |
| Cold: first-frame mark | 472 ms | 392 ms* | 475 ms (422–487) |
| Cold: world complete | 2 836 ms | 1 590 ms* | 1 580 ms (1 482–1 662) |

\*Median of 4 on a quieter GPU. The final review measured 456 ms and 1.77 s over 11 runs.

Warm world-complete grew by about 90 ms. That is the warm draw (DECISIONS [final]), which moves
2.5 MB of geometry uploads and the driver's pipeline builds from mid-dive into the reveal.

One warm timeline (ms after the engine chunk arrived):

- renderer 12, sky 23, prepare 32, city plan 72, terrain 163
- compile 179, first frame 190
- city 364, nature 397, clouds 429, traffic 615, people 638, air 661
- each stage-2 init waited 39–172 ms on its compile

### Phone profile (390×844 @3, touch → low at DPR 1.25, CPU ×4)

- Boot: first-frame mark at 451 ms, on screen at 502 ms, world complete at 1.90 s.
- Stage 2 shows eight rAF gaps of 50–83 ms. Stage-2 tasks are sliced finer this round, but a few
  build steps still run whole.
- Live loop: 60 fps at orbit, city, clouds, rooftops, street and night. CPU per frame is 4.5–5.3 ms
  median.
- The M3's GPU cannot be throttled, so whether a mid phone's GPU holds 30 fps is unverified. The low
  tier draws 487×1055 px with no bloom, no tilt-shift and no FXAA, at 345–400k triangles.

### Allocation

Production, final review: 28–40 KB per frame, of which 13–23 KB is LITTLEBIG's own. The rest is
three's: `uniform3f` with boxed doubles, the render-list sort and the matrix caches.

GC on the live loop at street level: 4 minor GCs in 6 s, max 1.8 ms, no rAF interval over 25 ms.

Ours, by size:

| Source | KB per frame |
|---|---|
| Traffic sim step (doubles passed to `scanSeg` / `idm` / `zoneBlock`) | ~6 |
| People sim step | ~4–5 |
| Clouds update | ~3 |
| Boats (`swellW` / `yawAlong` take 4–10 doubles each) | ~2.4 |
| Air `place` | ~1.3 |
| People update | ~1.3 |

### Memory

Every engine is released on close (above).

What stays after the first close is deliberate and bounded:

- ~4 MB of ArrayBuffers and ~6 MB of compiled code.
- The module caches in `world/planet.ts` (a Map by seed) and `world/icosphere.ts` (a Map by
  detail), the WeakMaps keyed by the planet, and the city plan and index (`world/city/index.ts`).

A re-open reuses all of them, which is why a warm boot is faster.

These caches must never hold a closure created inside the engine. The city index used to: its
terrain sampler was a closure, and the minifier inlined it into the engine's scope. It now takes the
planet as an object.

## What remains (ranked)

1. **Size: 18 KB over 150.** Only feature trims are left (above). Otherwise re-baseline again.
2. **High tier above DPR 1.** Shot-mode frames at DPR 1.5 are 11–26 ms. The live loop's adaptive
   resolution is what holds 60 fps on a retina screen. The fixed costs at DPR 1 are:
   - **Night bloom, 3–4 ms whenever night ground is in view** (orbit and city by day too, with the
     terminator in frame). It splits into the mip chain ~0.7, the ¼-res draw ~1.5 and the
     composite's taps ~1.4 ms. Two things were tried and gave no measurable gain: an exact
     composite early-out, and skipping the mip generation. Gating the bloom by day changes dawn and
     dusk frames visibly (`shots/C2/gatesweep.mjs`). A half-rate bloom (every other frame) is the
     one lever left untried.
   - **The 2048² shadow map, 2–3 ms.**
3. **Allocation: 13–23 KB per frame of ours.** The fix is mechanical but touches the people and
   traffic sims and their invariant tests. Hot helpers would take a Float64Array or a Vec3 instead
   of loose doubles, and closure state would live in typed arrays.
4. **Cold first frame ≈ the largest toon program's compile.** Terrain and ocean have 65–68 KB of
   GLSL each, ~0.45 s cold on a busy GPU. Going below that needs smaller first-frame shaders.
5. **Phone GPU.** Re-measure on a real mid-range phone before claiming 30 fps.
