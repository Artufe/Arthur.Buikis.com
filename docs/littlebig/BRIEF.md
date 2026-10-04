# LITTLEBIG: brief

A tiny cartoon planet you can hold in your hand, then fall into. You orbit it, spin it and zoom in
through the clouds, and the camera tips from a top-down globe view to a curved horizon until you're
standing in a busy little city street. Cars curve along the roads, planes trail contrails overhead,
and people stroll the sidewalks.

Art direction: a cartoon **SimCity**, crossed with **LittleBigPlanet**'s handmade charm and **Super
Mario Galaxy**'s little planets. Add the cozy colour of **Townscaper** / **Tiny Glade** and a light
**comic ink line**. It's a toy diorama, not a simulation.

This document is the spec, the art direction and the acceptance bar. `TASKS.md` splits it into
agent tasks. `DECISIONS.md` records every deviation (one line each, with a rationale).

---

## 0. Prime directive

**Quality comes above everything else.** When this works there is a *flow*: a zoom that never
stutters, a camera that eases instead of snapping, a world that feels alive at every distance.
Anything that breaks that flow is a defect, whether it's a hitch, a pop, a clipping camera, a car
driving through a house, an untextured-looking surface or a placeholder colour.

- If a requirement here conflicts with making it better, break the requirement and log it in
  `DECISIONS.md`.
- If something can't be made to look finished, cut it from the frame rather than ship it rough.
- The **wow moment** is the descent. From orbit, the camera dives through the cloud layer, and the
  horizon swings up while the city rises around you, until you land on the street. Every system
  must look right at every point of that dive: orbit (~400 m), cloud layer (~40 m), rooftops
  (~15 m) and street (1.7 m eye height).

## 1. Stack and hard constraints

- **TypeScript**, bundled by Next.js 16 / Turbopack. Static export, so everything is client-side.
  Load it with `next/dynamic({ ssr: false })` plus a dynamic `import()` of the engine. **Nothing of
  LITTLEBIG loads until the game is opened** (prefetching on intent is fine, see §8).
- **three.js 0.186 `WebGLRenderer` (WebGL2)**, imported from `three` and `three/addons/*`. Use
  WebGL rather than WebGPU because it has to run everywhere, including Safari, phones and an old
  laptop on in-flight Wi-Fi. three is already a site dependency (Snake uses it), so its chunk is
  shared and often already cached. Never import `three/webgpu` or `three/tsl` here.
- **Zero asset downloads.** Every mesh, colour, texture and sound is procedural, generated at boot
  from a fixed seed. No `public/` assets for the game itself: no images, models, fonts or KTX2.
  Small `DataTexture`s generated in code are fine.
- **Small.** LITTLEBIG's own JS ≤ **80 KB gzip** (three itself excluded). Avoid heavy addons.
- **Fast.** From the engine chunk arriving to the first frame of the planet: ≤ **400 ms** on the
  dev machine (Apple M3). Everything visible inside ≤ **1.5 s**. World generation is time-sliced
  across frames: the planet shows first, then the rest *animates in*. Buildings spring up out of the
  ground, trees pop, clouds fade in. The reveal is part of the charm, not a loading screen. Record
  boot timings per stage (`boot()` hook, see §9).
- **Smooth.** At 1280×800 on preset `high` on the M3: median frame ≤ 12 ms, no frame above
  median + 6 ms during a scripted descent. Preset `low` (phones, ≤4-core, coarse pointer) holds
  30 fps on a mid phone: DPR ≤ 1.5, no expensive post. Rules:
  - Instancing everywhere. ≤ 120 draw calls in any view.
  - Zero per-frame allocations in update loops (preallocate vectors and matrices).
  - No shader compiles after the reveal (warm them during boot with `renderer.compile`).
- **A good guest.** The floating window mounts and unmounts repeatedly, so `dispose()` releases
  every geometry, material, texture, render target, listener and rAF. Nothing leaks into, restyles
  or slows down the rest of the site. Pause rendering when the tab is hidden or the canvas is off
  screen.
- **Seeded and persistent.** The same planet every visit (fixed seed in `world/config.ts`).
  - Roads, buildings and trees never move between visits.
  - Cars, people and planes are **persistent entities**. They never spawn or despawn in view, never
    teleport, never overlap each other, and never leave their paths.
- **CI stays green:** `pnpm typecheck`, `pnpm test`, `pnpm build`. Pure world-generation code gets
  a few meaningful vitest specs next to it (`*.spec.ts`). No TDD ceremony, but the invariants in §5
  are tested.
- **Reduced motion** (`ctx.reducedMotion`): no camera shake, no FOV kick, no head bob. The fly-to
  and zoom are slower and critically damped, and the reveal fades instead of springing. The world
  still moves (cars, clouds), because that's content rather than camera motion.

## 2. Scale (1 unit = 1 m)

| Thing | Size |
|---|---|
| Planet radius at sea level `R` | **160** |
| Ocean floor / tallest peak | −14 / +26 |
| City plateau | +2.0, a cap ~90 m surface radius (≈0.56 rad), flat ±0.05 |
| Road (2 lanes) / sidewalk | 6.5 wide / 1.8 each side, curb +0.15 |
| Building footprint / height | 5–16 m / 4–34 m (downtown towers are toy-exaggerated) |
| Car / bus | 4.0 × 1.9 × 1.5 / 8 × 2.4 × 2.8 |
| Person | 1.7 tall, heads ~1.3× real proportion |
| Trees | 3–9 m |
| Clouds | altitude 36–48 m, puffs 6–20 m across |
| Planes | altitude 58–80 m, ~9 m wingspan (exaggerated) |
| Eye height (FPV) | 1.7 |
| Orbit range | eye height … altitude 420 |

The horizon from eye height is only ~23 m away, so the curvature is part of the look: towers peek
over the horizon, and a car vanishes over the hill and comes back around the planet. Don't fight
it, compose for it.

## 3. Art direction

**Shapes:** chunky, soft-cornered, slightly imperfect. Buildings get bevelled or rounded edges where
cheap, awnings, roof props (water tanks, AC units, antennae, solar panels), stepped tops and
setbacks. Trees are blobby spheres and stylised cones. Cars are toy-car proportioned: big wheels,
round cabins. Nothing is a bare box.

**Shading:** toon, a 3–4 step ramp with soft band edges. Add a warm key light, a cool sky-tinted
fill, rim light on silhouettes and gentle colour-tinted (not grey) shadows. **Ink outlines** in deep
indigo `#1B1530`, about 1.5 px at 1440p, on silhouettes and major creases. They thin and fade with
distance, so orbit view isn't noisy.

**Palette** (start here; the look pass may tune it, but keep it saturated *and* harmonious):

| Role | Colours |
|---|---|
| Ocean deep → shallow → foam | `#1E6FD9` → `#3FD0E0` → `#FFFFFF` |
| Sand / grass / meadow / forest | `#F6D98B` / `#7BCB4A` / `#A6DB5E` / `#2F8F4E` |
| Rock / snow | `#9A8F87` / `#F7FBFF` |
| Asphalt / markings / sidewalk | `#4A4E5A` / `#FFE066` / `#E6E1D6` |
| Walls | cream `#F3E9D2`, terracotta `#E07A5F`, teal `#3D9CA8`, mustard `#F2CC5B`, coral `#FF8A7A`, lilac `#A99CDA`, glass `#8EC9F0` |
| Roofs | red `#D9483B`, slate `#5B6B8C`, green `#5BA35B` |
| Sky top / horizon / space / rim | `#4FA8FF` / `#BDE6FF` / `#070B1A` / `#7FD3FF` |
| Site accent (sun glints, HUD) | amber `#FFB84D` |
| Ink | `#1B1530` |

**Light:** a slow day cycle (default ~8 min per day; it starts in late-afternoon golden light over
the city). On the night side:
- windows glow warm, streetlights pool, cars show headlights and taillights, and planes blink nav
  lights;
- the city reads as a constellation from orbit. That's a second wow, so make it beautiful.
- The terminator is soft and colourful: dusk pinks and purples.

**Atmosphere:**
- From space: a deep-blue starfield, a soft atmospheric rim glow around the planet and a cartoon
  sun disc.
- Near the ground: a blue sky gradient and gentle aerial fog toward the horizon.
- The transition between the two is continuous with altitude.

**The miniature look:** at mid altitudes (rooftops to cloud layer) a subtle tilt-shift blur at the
top and bottom of frame makes it read as a toy. It fades out at orbit and at street level.

## 4. Camera: the flow (the most important system)

One continuous model, with no modes the user can see. State: `focus` (a unit vector, the surface
point under the camera), `heading` (yaw about the local up), `alt` (height above the terrain or
roof surface under the camera) and the user's `lookPitch` / `lookYaw` offsets.

- **Zoom:**
  - The wheel, pinch and +/- set a target `alt` in log space. The camera follows it with a
    critically damped spring, never linear, never instant.
  - Wheel-zoom moves toward the point under the cursor (like a map). Double-click or double-tap
    flies to that point.
- **Pitch follows altitude:** straight down (looking at the planet centre) above ~120 m. It eases
  toward the horizon as `alt` drops, reaching ~−8° at 4 m. The user's look offset blends in more as
  you descend. Below ~25 m the horizon is in frame and the curvature sweeps across it. **That's the
  money shot.**
- **FOV:** ~40° in orbit, widening to ~70° at street level.
- **Drag:**
  - In orbit, dragging spins the planet under the cursor (the grabbed point stays under the
    cursor), with inertia.
  - Near the ground the same gesture becomes look-around.
  - The blend between the two is continuous with altitude.
- **Street level = FPV:**
  - Once `alt` reaches eye height, WASD / arrows walk along the surface (geodesic motion; up is
    always away from the centre). Shift runs, Space jumps in low gravity (it's a tiny planet, so
    jumps float).
  - In page mode, a click takes pointer lock and Esc releases it. Mouse drag looks around.
  - Collide with buildings (from the city plan's footprints) and slide along walls. Walk up and
    down terrain smoothly. Never fall through anything.
  - Zooming out (wheel / pinch / Q) lifts you off again.
- **Touch:**
  - One-finger drag spins or looks, pinch zooms, double-tap flies to a point.
  - At street level a left-thumb virtual stick walks; it appears only on touch, only at street
    level.
- **Constraints:**
  - The camera never goes inside terrain, a building or a cloud's near plane.
  - Near and far planes adapt to altitude, so there's no z-fighting at street level and no clipping
    in orbit.
- **HUD:** almost none. A one-line hint row (the site's mono font) fades in after 2 s idle and
  fades on interaction: `drag to spin · scroll to dive · double-click to fly`. At street level it
  becomes `wasd walk · space jump · scroll out to fly`. An altitude readout appears only in debug
  (F1).

## 5. World

**Planet** (`world/`, pure TS, no three.js imports, tested):
- A seeded 3D simplex fbm height function `heightAt(dir)`.
- 2–3 continents with beaches, rolling meadows, forests, a mountain range with snowcaps, lakes
  optional.
- The city plateau is blended in smoothly, with no cliff at its edge.
- Ocean everywhere else.
- The terrain mesh is an icosphere (detail 6–7), displaced, flat-shaded low-poly facets with
  per-vertex biome colour. The facets are part of the style, so keep them clean and avoid noisy
  slivers.

**City** (`world/city/`, pure, tested). Planned in a 2D tangent plane around the city centre and
mapped onto the sphere with the exponential map (`toSphere(x, z, h)` / `fromSphere(dir)`).
- **Roads:**
  - A road graph of nodes and edges. Each edge is a smooth curve (polyline sampled ≤ 1 m from a
    spline or arcs) with a width and a lane count.
  - Mix a gently curving ring road, curving avenues and a downtown street grid warped by a smooth
    field. Organic and SimCity-like, never a dead-straight lattice everywhere.
  - Intersections are real nodes with rounded corners.
  - Optionally one road leaves the city and winds along the coast to a small village or harbour.
- **Lots and buildings:**
  - Placed by frontage along road edges, set back from the sidewalk, oriented to the road.
  - Downtown towers sit near the centre, mid-rise around them, houses with gardens at the edge,
    plus a park and a plaza.
  - 1–3 landmarks: e.g. a clock tower, a stadium or a radio mast with a blinking light.
- **Invariants** (tests):
  - No building footprint intersects any road or sidewalk, or another building.
  - Every road edge is reachable from every other.
  - Lanes are continuous through intersections.
  - Everything sits inside the plateau.

**Life:**
- **Cars** drive on the right, in lanes, along the curves.
  - At nodes they pick a next edge and turn on a smooth curve through the intersection.
  - They keep their distance (car-following), and simple stop/yield at intersections is enough to
    never overlap.
  - A few buses and trucks.
- **People** walk the sidewalks, plaza and park. They're only meaningful below ~30 m; LOD them out
  above that. Use a stylised walk cycle in the vertex shader.
- **Planes:** 3–5 on tilted great-circle routes with banking and fading contrail ribbons. Add a
  blimp or hot-air balloons.
- **Extras that sell a living world** (only if they look finished): windmills turning on a ridge, a
  lighthouse with a sweeping beam at night, boats in the harbour, birds over the park, a fountain.

## 6. Code layout

```
components/littlebig/
  littlebig-canvas.tsx        React wrapper: boot, loading/fallback, resize, hint row, dev hooks
  littlebig-window-host.tsx   FloatingWindow host (palette → planet-bus)
  core/        engine.ts (createEngine), contracts.ts, systems.ts, loop/timing, quality, boot log,
               dev hooks (window.__littlebig), shared uniforms
  world/       pure generation: config, rng, noise, planet height/biomes, sphere math, city/ (plan,
               roads, lots, buildings, collision), *.spec.ts
  render/      toon.ts (shared toon material factory + ramp), post/ (outlines, tilt-shift, bloom)
  camera/      rig (orbit↔FPV), input (mouse/keys/touch), collision
  terrain/  ocean/  nature/  city/  traffic/  people/  air/  sky/  clouds/   one directory per system
app/planet/page.tsx           full-viewport route (/planet), like /surf
lib/planet-bus.ts             open/close/raise events, like surf-bus
scripts/littlebig-shot.mjs    review tool (§9)
docs/littlebig/               BRIEF, TASKS, DECISIONS, PERF, shots/ (gitignored except milestones/)
```

Systems implement `System` from `core/contracts.ts` and register in `core/systems.ts`. A system
owns its directory. Cross-system changes go through `contracts.ts` (additive) and get noted in
`DECISIONS.md`.

## 7. Site integration

- **Palette:**
  - The command `visit planet` (hint `littlebig · 3d`, keywords planet, city, littlebig, world,
    game) opens the floating window via `planet-bus`.
  - Its ↗ expands to `/planet`, which owns the whole viewport: the nav is hidden, as on /surf, and
    a `← back to site` link sits top left.
  - `/planet` goes in `SHADER_EXCLUDED_ROUTES`.
- **/play:**
  - LITTLEBIG becomes the third game card, in the same structure as Snake and GOLDENLINE: index
    row, card with chip/overlay, receipt.
  - Its looping clip is the descent from orbit to street, rendered frame by frame through the shot
    tool. It needs a poster under 350 KB and a clip under 2 MB.
- **Home Play strip:** the copy and grid adapt to three games.
- **Elsewhere:** sitemap, llms.txt and llms-full.txt list `/planet/`. Copy follows the site's voice
  (lowercase mono labels, plain sentences).

## 8. Loading

- Lazy chunk, prefetched on intent:
  - on palette open (as GOLDENLINE does);
  - when a LITTLEBIG card or tile on /play or home scrolls into view;
  - on idle on /play.
- Boot is staged and time-sliced:
  1. renderer + sky + planet terrain + ocean → first frame;
  2. then nature, city, clouds, traffic, people and air, each animating in.
- WebGL2 unavailable → one line of text (site voice), no crash.
- Loading UI: none if possible, since the first frame should beat any spinner. Otherwise a one-line
  mono label over the site's surface colour.

## 9. Review tooling (built in the foundation, used by every agent)

`?shot=1` puts the game in deterministic mode:
- fixed seed and sim time;
- no real-time advance unless stepped;
- the reveal finished instantly;
- the hint row hidden.

The dev hooks on `window.__littlebig`:
- `setView({lat, lon, alt, heading, pitch})` and `setTime(t)`;
- `step(dt, n)`;
- `shots()` / `shot(name)`, from a named shot list;
- `perf(frames)` → median / p95 / max ms and draw calls;
- `boot()` → stage timings;
- `params` for live tuning;
- `state()` → current camera and sim.

`node scripts/littlebig-shot.mjs` drives headless Chromium (WebGL on Metal ANGLE) against the dev
server:
```
--shot orbit,city,clouds,rooftops,street,horizon,night,dusk   named shots (one PNG each)
--view lat,lon,alt,heading,pitch   custom camera       --t 120   sim time (s)
--seq N --interval 0.1             frame sequences     --dive    scripted orbit→street descent
--perf N                           frame-time JSON     --boot    startup timeline
--size 1600x1000 (default)         --q low|high        --url http://localhost:3047
--p key=value                      param overrides     --out <file|dir>
```
Console errors and warnings from the page are always printed.

**Review protocol (every agent):**
1. Build.
2. Shoot the standard list plus your own angles.
3. **Look at the PNGs yourself** (Read them).
4. List what's wrong as a harsh art director would.
5. Fix and repeat.

Report only when your work is good at every altitude, not when it merely runs. Put evidence shots
under `docs/littlebig/shots/<task-id>/` (gitignored).
