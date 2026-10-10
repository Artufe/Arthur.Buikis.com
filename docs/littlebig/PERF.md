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

## v2: the space layer and the falling-through-clouds overlay (S1f, dev server, 1280×800, high)

Measured on a GPU shared with 10–19 other headless browsers (other agents' review runs): no quiet
GPU was available, so these are paired A/B medians and best-of-rounds, noise about ±0.5 ms (the
best-of-rounds differences go negative). Round 2 re-measured after the lateral set, the new puff
shape and the streaks moved under the puffs (`scratchpad perf.mjs`: base / held / off interleaved
per round, reloading through other agents' hot reloads).

| | round 1 | round 2 |
|---|---|---|
| Overlay held at full cover (`clouds.force=1`) − `crossParts=0`, median Δ, 9–11 rounds × 60 frames (radial set: the focus in frame) | flight +0.8, alongside +0.5, rooftops +0.5 ms | flight +0.3, alongside +0.4, rooftops +0.4 ms |
| …the lateral set (`clouds.forceLat=1`: the focus off-screen, a climb) | (not built) | flight +1.0, alongside +0.5, rooftops +0.8 ms (re-runs 0.6–1.6: the GPU got busier) |
| …body alone / puffs alone (`crossParts=1` / `2`) − off | body about +0.2 ms | both within ±0.2 ms (noise) |
| Overlay draw calls | +3 (body, puffs, streaks) +1 when following something (its mesh re-drawn, scissored) | same (the lateral set and the caps are instances of the puff draw) |
| The /play dive, 120 frames (`--dive 120 --perf 1`) | median 11.4 ms, p95 15, max 16.5, no hitches, ≤ 80 draw calls | median 11.2 ms, p95 16.2, max 23.5, 1 hitch, ≤ 80 draw calls |
| Leak check (`--leak 6 --close-at 300,ready`) | clean | clean (0 engines alive, listeners 53 / 149 before and after) |
| Space layer | 2 draw calls (bodies, lights) | same |

With the focus in frame (dives, zooms in, rides looking ahead) the overlay is within its 0.4 ms
budget at full cover; with the focus off-screen (climbing out looking down: the lateral set, a denser
even field) it is about 0.1–0.6 ms over, transiently (about 0.6 s per crossing). The far lateral layer
is mostly hidden under the near one (a still with and without 45 % of it looks the same), so it is
the first thing to drop if a quiet-GPU measurement says so. Its cost is blended overdraw: about 1 body layer plus 1–2 puff layers. Apple's ANGLE path
does no early depth rejection for blended, discarding fragments, so drawing back to front (needed for
the single far depth that keeps post's ink and night grade flat over it) costs nothing there. The
puff sprites are quads fitted round each puff's base and bumps (about 30 % fewer fragments than round
sprites); only one of the radial and lateral sets draws at a time (the other's sprites collapse in the
vertex shader, ~1.8 k vertices); the body's per-pixel speed lines are gone (the instanced streaks,
clipped to the body, replace them). Low tier draws the near layer only. The followed thing's scan
(`clouds/subject.ts`) runs only while nothing is found and an episode may start: ~0.03 ms a scan at rooftops (44 visible meshes, 2.2 k instances).

**Round 3 (S1f r7), on a quiet GPU** (0 other headless browsers during the runs; paired A/B, 13
rounds × 60 frames, `docs/littlebig/shots/v2-S1f/r7/perfab.mjs`): overlay held at full cover minus
no episode, radial set / lateral set: flight +0.4 / +0.4 ms, clouds +0.4 / +0.2 ms, rooftops
+0.2 / +0.2 ms (the timer's 0.1 ms step is the resolution). Within the 0.4 ms budget, after thinning
the lateral set (55 % of far and 22 % of near cells empty, were 45 / 16: the wisps now show in the
gaps) to pay for the far/near split (+1 draw call: body, far puffs, streaks, near puffs, ring, and
the followed thing's re-draw = +6 calls during an episode, none otherwise). Space layer:
`space.show` on minus off, ≤ 0.2 ms (noise) and 2 draw calls on orbit / station / skywatch /
alongside; those views total 49–70 calls, net frame 2.0–4.4 ms. The /play dive (`--dive 120 --perf
1`): median 6.3 ms, p95 9.3, max 11, no hitches, ≤ 81 draw calls. Leak check (`--leak 6 --close-at
300,ready`): clean (0 engines alive, listeners 53 / 149 before and after).

## v2: the region (R2, dev server, 1280×800, high; the machine shared with other agents' runs)

**Build (`getRegion()`, budget ≤ 20 ms cold; refine round 1):** six fresh browser contexts on
`/planet/?shot=1`, `ctx.world.region.buildMs`: 15.9, 15.4, 16.0, 15.6, 15.8, 15.2 ms (bake misses 0,
415 carve primitives). Split: sites 2.6–3.2 (the bake's decode included), plans 0.0–0.4 (eight baked
skeletons), towns 1.1–1.4, roads 4.9–5.2 (finish 1.4–1.9: `routeLift` live, `routeSmooth` baked;
grade 0.1–0.4, baked), carve build 4.3–4.5 (the CSR grid; 5.9–6.4 with the first samples). R2's first
build was 18.6–18.9 ms. The streets of the eight towns are planned on the network's first read
(`townStreets()`), off this path: ~2 ms of planTown in node, and the network build lands in the boot's
stage 2 (`init region` 8.5 ms in `--boot`). In the boot's `planet` mark: 19.7 ms (was 26), total
565 ms to stage 2 done. Regenerate the bake after any change that moves a site, a gate, a route or a
plan: `LB_REGION_BAKE=1 pnpm vitest run components/littlebig/world/region/bake.spec.ts` (the bake spec
fails when it is stale; a stale skeleton also warns in development).

**Size:** `world/region/baked.ts` is 10.0 KB, 6.4 KB gzip (bake format 2: fixed-point entries as
difference residuals in text; R2's first bake was 5 KB, and this round's skeletons, finish and grade
in format 1 were 16.3 KB / 11.3 KB gzip). The region's own code (`world/region/**`, `region/`,
`planet.ts`), each file minified and gzipped alone: 60.5 KB against 39.9 KB at HEAD (R1). Of the
+20.6 KB, towns.ts is +9.0 (the eight organic plans and their machinery), baked.ts +3.6, build.ts
+3.3. These sums overstate the bundle: spec-only plan metrics (`planFaces`, `planSymmetry`, …) are
tree-shaken from it. **The engine as a whole is over V2's 260 KB.** A rolldown bundle of
`core/engine.ts` (three external, the GLSL loader applied; it reads v1 at 174.3 KB against the 164.3
KB a production build measured, so ~6 % high) is 309.0 KB gzip for the working tree, ≈ 291 KB in
production, against 260.3 KB (≈ 245 KB) at HEAD. Per directory since HEAD (per-file sums): people
+34.7, world/region +24.2, camera +13.9, clouds +4.8, ui +3.8, core +1.8. A production `--bundle`
run is still owed; it was not run here because it needs `pnpm build` on the shared tree.

**Frames** (`--perf 60 --reps 3`, no overlay, refine round 1): orbit 3.6 ms net (60 draw calls,
0.73 M triangles), street 2.8 (72), region-east 3.8 (60, 0.72 M), region-far 3.9 (55, 0.75 M),
town-far-haven 3.7 (58, 0.95 M), quay-port-pebble 2.2 (54), alpine-street 2.1 (51); no hitches. The
region adds nothing per frame without `?p.region.debug=1` (its labels are the UI's); the overlay is a
review tool (one mesh + one line set).

**Queries:** `carve()` off the network is one cell read; on it, a few primitives (the inverse-square
bank blend adds a handful of segments within the cut-off). `keepOut()` is one cell read of its own
lazily built buckets plus a few primitives (zero-alloc, margin clamped to 8 m), spec'd ≤ 1 µs a call:
fine per scatter instance and per camera frame.

**Refine round 2.** Build: six fresh contexts, 17.8, 17.3, 17.6, 17.5, 14.6, 15.7 ms (budget 20; bake misses 0, 399 primitives; machine shared with other agents' runs, refine 1 measured 15.2–16.0 on a quieter machine). Split: sites 2.5–3.7, towns 1.3–1.6, roads 4.7–6.0 (finish 1.4–2.2), carve build 4.1–5.2. In node the same build is 5.1–5.7 ms warm, 14–28 ms in the first runs (JIT). Size: every search, planner pass and the bake writer are compiled out of production (`process.env.NODE_ENV === 'production' ? null : …`, the bake replayed by key). The rolldown engine bundle went 335.4 → 330.0 KB gzip (the whole working tree, every agent's code; HEAD measures 280.8 KB the same way). buildRegion with its world dependencies is 46.9 KB gzip, against 33.3 KB at HEAD; its town generators (towns.ts, kept for the lazy street planning) are 11.0 KB of that. `baked.ts` is 10.6 KB (it now holds the ferries' A* too). Frames (`--perf 60 --reps 3`, no overlay): orbit 3.7 ms net (60 draw calls, 0.76 M triangles), town-port-pebble 3.1 (53), quay-port-pebble 2.3 (54), region-west 3.9 (59), street 2.7 (72); no hitches.

## Review follow-up: production route budget (2026-10-09)

The actual Next production export measures **320.8 KiB gzip own JavaScript**, **485.3 KiB
including Three.js**, incremental to `/about/`. This replaces the 330 KiB Rolldown estimate
above for this working tree. The historical **260 KiB own-JS target is still unmet**; it is
not being reported as a performance pass. Preserving the current world and gameplay scope,
CI now enforces explicit **330 KiB own / 500 KiB total incremental no-regression ceilings**.
Reaching 260 KiB requires a separate feature-loading/size reduction effort; merely splitting
modules does not reduce the bytes needed by the complete world.

Run `pnpm build` then `node scripts/littlebig-bundle.mjs`. The script serves `out/` on an
isolated ephemeral loopback port, waits for the real HUD and network idle, compares route
requests, and gzips each transferred JS chunk at level 9. The own-JS classifier follows the
existing shot tool's Three.js markers; the total ceiling also catches chunk-merging or
classification changes. Missing/incomplete loads fail. `LB_OWN_KIB` / `LB_TOTAL_KIB` override
the ceilings for experiments; CI uses the checked-in defaults.

**v2 towns and roads (2026-10-09).** The same measurement with T1 (towns) and H1 (roads)
landed: **363.7 KiB own / 528.2 KiB total**. Stubbing each system out gives towns 24.7 KiB
and roads 16.6 KiB (plus 1.4 KiB of keep-out wiring in nature/). The ceilings are now
**372 / 540**, the same ~8 / 12 KiB of headroom the 330 / 500 ceilings had. The towns and
roads add at most 14 draw calls and stay inside every frame budget (orbit 83 calls, region-west
83, street 78); the world is complete at 1.2–1.7 s against 2.5 s.

**v2 bird flight (2026-10-09).** The bird's lift-and-drag flight model, landing, crashes, the
towns' collision service and the jointed wing, leg and tail animation measure **373.0 KiB own /
537.5 KiB total**, +9.3 KiB on the towns-and-roads tree. The ceilings are now **381 / 550**.
The bird stays one draw call plus its shadow, and its step costs about 4 µs a frame.

**v2 town life (2026-10-09).** The region's traffic (transit/: 55 vehicles, a city bus loop, three
ferries) and the townsfolk (townsfolk/: 204 walkers, sitters and stall keepers in the eight towns)
measure **415.0 KiB own / 579.5 KiB total**, +42 KiB (transit about 23.5, townsfolk about 19). The
ceilings are now **423 / 592**. No new shader programs; Far Haven's street draws 84 calls at about
2.9 ms; stage 2 completes at 1.6–1.7 s (transit's sliced init about 450 ms). The own JS has grown
from 321 to 415 KiB over v2's phase 2; a size pass (or loading the region's life as its own chunk)
is the open item.

The engine now owns HUD, touch detection and stick presentation subscriptions. They run after
its render, pause when its loop is suspended and are released on disposal. Deterministic sim,
instanced rendering, staged shader warmup and adaptive resolution remain in place.
