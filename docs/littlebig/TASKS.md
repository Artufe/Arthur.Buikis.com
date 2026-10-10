# LITTLEBIG: agent task list

`BRIEF.md` split into self-contained agent tasks. The main agent is the **orchestrator**. It wrote
the brief, runs the agents in phases (**at most 4 at once**), integrates and commits between
phases, runs the review gates, and does the final review.

```
Phase 1  F0 foundation (core, contracts, world math, terrain v0, camera model, wiring, shot tool)
Phase 2  A1 terrain+ocean+nature ┐
         A2 city                 ├─ parallel ──► orchestrator: integrate, commit, gate G1
         A3 sky+clouds+light     │
         A4 camera+controls      ┘
Phase 3  B1 traffic              ┐
         B2 people+street life   ├─ parallel ──► orchestrator: integrate, commit, gate G2 (critic panel)
         B3 air                  │
         B4 look+post            ┘
Phase 4  fix round from G2 (≤4 agents) ──► C1 site integration + media ∥ C2 load/size/perf ──► final review
```

## Rules for every agent (binding)

- **Shared worktree, shared dev server.** The dev server is already running at
  `http://localhost:3047`. Don't start another one and don't stop it. Other agents edit other
  directories at the same time.
- **Own your files.** Edit only the files and directories your task owns. You may make
  `core/contracts.ts` additions (additive only: never rename or remove) and register your system in
  `core/systems.ts`. Note every contract change in `DECISIONS.md`.
- **If the page fails to compile** because of another agent's half-written file, wait a minute and
  retry. Don't edit their file. Run `pnpm typecheck`, fix errors in your files, and report errors
  you see in other files.
- **Git:** don't commit, push, stash, reset, checkout or clean. The orchestrator commits between
  phases.
- **Review protocol (BRIEF §9).** Build, shoot, *look at the PNGs yourself*, critique harshly, fix,
  repeat. Stop when it's good at every altitude in the dive, not when it runs. Evidence shots go in
  `docs/littlebig/shots/<task-id>/`.
- **Performance is part of done.** Run `--perf` on the shots your system appears in. Stay inside
  the BRIEF §1 budgets. Instancing; no per-frame allocation.
- **Tests:** a few meaningful vitest specs for pure logic (invariants, determinism), next to the
  code. No TDD ceremony.
- **Report** (your final message), in this order:
  1. What you built.
  2. Files.
  3. Contract changes.
  4. Shot paths, best first.
  5. Perf numbers.
  6. Known weaknesses, ranked.

  Be honest. The orchestrator re-shoots everything.

## Contract decisions after the F0 review (binding)

The details live in the code comments (`core/contracts.ts`, `world/city/types.ts`,
`render/toon.ts`) and in `DECISIONS.md`. In short:

- **Stage-2 init order:** build meshes → add them to the scene → `await ctx.compile()` (colour and
  shadow programs, no hitch) → `ctx.reveal.slot()` → write `aReveal`. Create every material in
  `init`. Reuse patch keys; reveal durations and fade ranges are uniforms. In dev, a program built
  mid-flow logs a warning: treat it as a bug.
- **Trees:** A2 places every city tree as a `Feature` of kind `'tree'` (with `size` and `seed`),
  in streets, the park and gardens. A1 renders **all** trees, from those features plus its own
  scatter only where `cityIndex.classify` is `'outside'` (or `'free'` outside every area).
- **City ground:** A2 owns every surface inside the plan radius, drawn at `ROAD_H` (roads,
  intersections), `ROAD_H + CURB_H` (sidewalks) and `AREA_H` (lots, plaza, park lawns, gardens)
  from `world/config.ts`. A1 colours `Biome.City` facets as a neutral base only.
- **Budgets for A2:** city plan + index ≤ 30 ms on the M3 (it sits on the first-frame path, see
  the `city plan` boot mark). Use spatial-grid placement tests (never all-pairs) and run
  `validatePlan` only in specs, never at runtime.
- **Footprinted instances** (buildings, lots, benches) take their matrix from `planBasis()`, not
  `planFrame()`, or neighbours overlap on screen.
- **Ink (B4):** outlines come from depth (plus normals reconstructed from depth). Anything that
  must not be inked does not write depth, or uses `LAYER_NO_INK`. A custom `ShaderMaterial` merges
  `ctx.uniforms` and ends with the tone-mapping and colour-space chunks.
- **Light (A3):** write `lbDuskTint` (the terminator colour, per fragment) and optionally
  `lbCloudShadow*`. Keep the sun light's own colour golden at most, never sunset-orange across
  the whole lit hemisphere.
- **Traffic and people (B1, B2):** cars stop at `Lane.stopS`; crossings carry `laneS`; the
  runtime handshake is `ctx.services.crossings` (`busy` written by people, `blocked` by traffic).
  Connectors closer than `VEHICLE_CLEARANCE` are listed as conflicts.
- **LOD and fades:** use `ctx.view.altTerrain` (roofs ignored), not `alt`. The toon kit's `fade`
  option dithers the mesh and its shadow by altitude or distance with no custom patch.

---

## F0: Foundation

**Owns:** everything not owned below, for now: `core/`, `world/` (except `world/city/plan*`),
`render/toon.ts`, `camera/`, `terrain/` v0, `ocean/` v0, `sky/` v0, `littlebig-canvas.tsx`,
`littlebig-window-host.tsx`, `app/planet/page.tsx`, `lib/planet-bus.ts`, palette command, nav hide,
`SHADER_EXCLUDED_ROUTES`, `scripts/littlebig-shot.mjs`, `docs/littlebig/DECISIONS.md`.

**Build:**
1. **Wiring:**
   - `planet-bus`, the window host in `app/layout.tsx`, `/planet` (full viewport like `/surf`,
     nav hidden, back link), the palette command `visit planet`, and the shader exclusion.
   - The engine chunk loads only on open. Prefetch on palette keys, as GOLDENLINE does.
2. **`core/`:**
   - `createEngine({canvas, variant, reducedMotion, search, onProgress})`, plus `resize`, `start`
     and `dispose`.
   - Quality tiers (`low` / `high`, auto-detected, overridable with `?q=`) and DPR caps. Pause when
     hidden or off-screen.
   - The `System` contract, `systems.ts`, shared uniforms (time, sunDir, night factor, camera alt),
     a fixed-step sim clock, the staged boot with a timeline, the reveal animator used by systems
     (`reveal(t)`: spring in), and the WebGL2-missing fallback.
3. **`world/`** (pure, tested):
   - Seeded rng and 3D simplex noise, sphere math (tangent frames, geodesic moves, lat/lon), and
     `heightAt(dir)` / `biomeAt(dir)` with continents, mountains and the flat city plateau.
   - `world/city/types.ts`: the city contract (road graph with curved edges and lanes, buildings as
     2D oriented boxes with height and style, sidewalks/footpaths, parks, plaza,
     `toSphere` / `fromSphere`, collision query).
   - A **stub** plan (a ring road + 4 avenues + a few boxes) so other systems have data. A2
     replaces it.
4. **`render/toon.ts`:** the shared toon material factory (MeshToonMaterial plus a ramp
   DataTexture), instancing and vertex colours, and hooks for rim light and the night emissive
   driven by the shared uniforms. Every system uses it, so B4 can restyle everything in one place.
5. **v0 systems**, good enough to judge the others against:
   - terrain (icosphere, flat-shaded, biome colours);
   - ocean (a toon sphere);
   - sky (a space→blue gradient by altitude, stars, sun, directional light with a shadow map fitted
     to the view).
6. **`camera/`:** the full BRIEF §4 model, so `setView(lat, lon, alt, heading, pitch)` is exact and
   shots are comparable: altitude-driven pitch and FOV, log zoom with a damped spring, drag spin,
   basic WASD at street level, and adaptive near/far. A4 polishes the feel later.
7. **Review tooling:** `?shot=1` deterministic mode, `window.__littlebig` hooks and
   `scripts/littlebig-shot.mjs`, all exactly as BRIEF §9.
   - Named shots: `orbit` (alt 380), `city` (alt 120 over the city), `clouds` (alt 44, in the
     cloud layer), `rooftops` (alt 16), `street` (FPV in a city street), `horizon` (alt 6 looking
     along the curve), `night` (orbit over the night side), `dusk` (street at sunset).
   - `--dive` renders a scripted orbit→street descent as a frame sequence.

**Done when:**
- The palette opens a window showing the planet. ↗ goes to `/planet`, and closing and reopening it
  10× leaks nothing.
- Every named shot renders. `--perf` and `--boot` print numbers. `pnpm typecheck`, `pnpm test` and
  `pnpm build` pass.
- The contracts are documented in comments: they're what four parallel agents build against next.

## A1: Terrain, ocean, nature

**Owns:** `terrain/`, `ocean/`, `nature/`. May tune `world/planet*` (height and biomes), keeping
the plateau contract.

Build the planet the city sits on, so it looks finished from orbit down to your feet:
- **Terrain:** clean low-poly facets; coasts with sandy beaches; meadows with colour variation;
  forested hills; one mountain range with rocky faces and snowcaps.
- **Ocean:** depth-tinted water (shallow turquoise over sand → deep blue), animated shoreline foam
  bands, gentle low-poly swell, sparkle in the sun path and toon specular. It reads at orbit *and*
  at street level on the beach.
- **Nature** (instanced and varied):
  - Blobby and conifer trees in forests and in the city (A2 places city trees as `'tree'`
    features; A1 renders all of them, see the contract decisions above), rocks and flowers.
  - Optional, if they look finished: windmills turning on a ridge, a lighthouse on a headland with
    a night beam.
- **Ground cover near the camera:** grass tufts and flowers fade in below ~10 m, so street level
  isn't bare.
- **No visible LOD popping.** Fade by distance or altitude.

## A2: City

**Owns:** `world/city/` (plan, roads, lots, buildings, collision, specs) and `city/`.

- **Plan** (pure, seeded, tested):
  - A road graph with curved edges (ring road, curving avenues, a warped downtown grid), proper
    intersections and lanes.
  - Frontage-based lots and buildings that never clash with roads, sidewalks or each other: the
    BRIEF §5 invariants as specs.
  - Downtown → mid-rise → houses with gardens, plus a park, a plaza and 1–3 landmarks.
  - Optional: a road out to a coastal village.
  - Exports the paths B1 and B2 need: lane curves with connectivity at nodes, sidewalk/footpath
    loops and intersection turn curves.
- **Render:**
  - Road ribbons with lane markings, crosswalks, curbs and sidewalks; intersection patches with
    rounded corners.
  - Buildings in instanced toon styles with variety: walls, window grids (a procedural shader, lit
    at night by the night uniform), roofs and roof props, awnings, setbacks.
  - Streetlights (pooling light at night), park trees and benches through instancing.
- **Data first:** keep the plan's data shape stable early so B1 and B2 can rely on it.
- **Acceptance:**
  - From `city` (120 m) it reads as a charming SimCity town.
  - From `street` (1.7 m) it holds up: facades have depth, there's no z-fighting, and roads meet
    cleanly.
  - Draw calls stay within budget.

## A3: Sky, clouds, light

**Owns:** `sky/`, `clouds/`, the day cycle and the lighting rig (sun, fill, shadows).

- **Sky:** a space starfield and an atmospheric rim glow around the planet seen from orbit. It
  blends continuously into a blue sky with horizon haze near the ground, plus aerial fog.
  - The sun is a cartoon disc. Add a moon. The terminator is soft, in pink and purple.
- **Day cycle:** default ~8 min per day; it starts in late-afternoon golden light over the city.
  It drives the shared `sunDir` / `night` uniforms that the windows, streetlights and headlights
  read.
- **Shadows:** a toon shadow map fitted to the view at every altitude, stable with no swimming. In
  orbit, cloud shadows on the ground are a bonus.
- **Clouds:**
  - Puffy toon clouds: instanced puff clusters with soft bands and rim light, drifting.
  - **The camera passes through the cloud layer during the dive**, so it must look great from below,
    from above and while passing through. Fade puffs near the camera and add a brief soft white-out.

## A4: Camera and controls

**Owns:** `camera/` (after F0), the hint row in `littlebig-canvas.tsx` and touch UI.

Make BRIEF §4 *feel* perfect:
- Grab-spin with inertia (the grabbed point stays under the cursor), and wheel zoom toward the
  cursor in log space with a critically damped spring.
- Double-click fly-to along a pleasing arc. The pitch and FOV blend with altitude.
- FPV walking (geodesic, collisions with buildings and sliding, terrain following, low-gravity jump,
  run), pointer lock in page mode, then lift-off on zoom out.
- Touch: drag, pinch, double-tap, and a virtual stick at street level.
- Keyboard: WASD / arrows, Q/E or +/- zoom.
- The hint row.
- Reduced-motion variants.
- **Test it like a player:**
  - Script input sequences with Playwright (wheel, drag, keys) and capture `--seq` frames.
  - Check there's no jitter, no snapping, no clipping into buildings or terrain, and no gimbal
    flips at the poles.
  - Keep a few pure specs for the camera math.

## B1: Traffic

**Owns:** `traffic/`.

- Persistent cars, buses and trucks on A2's lane curves:
  - right-hand traffic;
  - smooth turns through intersections;
  - car-following with spacing;
  - simple yield/stop so they never overlap;
  - no teleport, spawn or despawn in view.
- Toy-car meshes (instanced, a palette of body colours, wheels that turn), headlights and
  taillights at night, and gentle suspension bob.
- They look right at street level: cars pass you and their wheels touch the road.
- Specs: there are no overlaps over a long simulated run, and cars stay on lanes.

## B2: People and street life

**Owns:** `people/`.

- Pedestrians on the sidewalks, plaza and park: instanced stylised figures (chunky heads, varied
  shirts and skin tones), with a vertex-shader walk cycle.
- They wait at crosswalks, or keep to paths that never cross car lanes.
- LOD: invisible above ~30 m, fading in on the way down.
- Optional, if finished: a few people sitting on benches, a dog, a fountain in the plaza, birds
  that scatter.

## B3: Air

**Owns:** `air/`.

- 3–5 cartoon planes on tilted great-circle routes, with banking, fading contrail ribbons and
  blinking nav lights at night.
- A blimp or 2–3 hot-air balloons drifting low over the city.
- Air traffic is visible and charming from orbit, readable from the cloud layer, and seen
  overhead from the street.

## B4: Look and post

**Owns:** `render/` (toon factory tuning, post pipeline), quality tiers in collaboration with
F0's core.

- **Ink outlines** (BRIEF §3): edge detection on depth and normals, or a better technique, fading
  with distance.
- **Toon ramp and light tuning** across the whole scene; colour grade; bloom for night lights and
  the sun; AA that keeps lines clean; the tilt-shift miniature effect at mid altitude.
- **Quality tiers:** `low` drops the expensive post, keeps the look.
- **A cohesion pass:** read every system's shots and file concrete, owner-tagged notes (palette
  clashes, ramp inconsistencies) in your report. Fix what lives in `render/`.

## C1: Site integration and media

**Owns:** `content/play.ts`, `components/play*`, `components/play/*`, `app/play/`, the home Play
strip, tests for these, the llms routes, the sitemap, `docs/play-media.md`, and
`public/play/littlebig.*`.

- **The /play card and receipt** (facts from the orchestrator only).
- **The home strip for three games.**
- **The clip:** the descent, rendered frame by frame through the shot tool and encoded with ffmpeg.
  It loops seamlessly, at 1280×800 and 30 fps, poster < 350 KB, clip < 2 MB.
- **Prefetch on view.**
- **Tests** updated: vitest and e2e.

## C2: Load, size, performance

**Owns:** cross-cutting perf fixes. Coordinate edits through the orchestrator.

- **Bundle:** measure the LITTLEBIG chunk (≤ 150 KB gz excluding three; re-baselined from 80 KB in phase 4, see `DECISIONS.md` [C2] and `PERF.md`).
- **Boot:** the timeline against the BRIEF §1 budgets, shader warm-up, time-slicing, and a worker
  if it pays.
- **Frame time:** draw calls and frame time on the scripted dive.
- **Leaks:** window open/close leak checks.
- **The low tier on a throttled mobile profile.**
- **Write `PERF.md`.**
