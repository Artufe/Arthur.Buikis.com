# Pier (`pier/`)

A slender, sun-bleached timber pier on paired pilings, from the dry sand (`PIER.rootX`) past the
break into the channel (`PIER.tipX`), with stairs down to the sand at the root. Owner: A4.

| file | what |
|---|---|
| `plan.ts` | The construction plan: every plank, stringer, cap, rim, post, rail, brace, piling, rope span, whipping and lantern, computed once from `PIER` and `terrain.height` (so piling lengths and the stair follow the ground). Deterministic PRNG. |
| `service.ts` | `PierService`: `surfaceAt` (deck + a smooth ramp through the stair nosings), `clampToDeck` (railings, tip rail, the stair opening), `pilings`, `pilingRadius`. |
| `geometry.ts` | Rounded-arris boards (UVs in wood-strip tiles), the unit piling, parallel-transport tubes, a merge helper. |
| `wood.ts` | The timber material (one graph, flavours `deck` / `timber` / `pile`). |
| `rope.ts` | Three-strand manila rope (strands are shading), sag in the vertex shader; whippings on rail joints. |
| `lantern.ts` | Unlit hurricane lanterns on iron brackets. |
| `water-fx.ts` | Per-piling ocean sampling → foam/wake splats, foam collars, spray bursts. |
| `spray.ts` | Pooled GPU spray (compute sim + instanced sprites). |
| `shade.ts` | Hashes, animated Voronoi caustics, shared uniforms. |
| `textures.ts`, `tools/quilt-wood.py` | The quilted wood strip (see ASSETS.md) and a boot-time noise texture. |

## For the player / surf (A6, B1)

- **Read `ctx.services.pier` every frame; don't cache it in `init()`.** The pier system inits
  after the player (see `systems.ts`), so at player-init time the slot still holds the stub.
- `surfaceAt(x, z, feetY)` returns the deck height (4.2 m) on the deck, a smooth ramp over the
  stairs at the root (x from `PIER.rootX` to ≈ `rootX + 3.5`, |z − PIER.z| ≤ 1 m), or `NaN`.
  It only answers when the feet are within 0.9 m below the surface, so walking *under* the deck
  still works.
- `clampToDeck(x, z, feetY, out)` keeps a 0.28 m body inside the railings, off the tip rail and
  (at the root) inside the stair opening. Call it after integrating the walk.
- `pilings` is `[x0, z0, x1, z1, …]` at the waterline (72 pilings, two per bent every 6 m,
  z = PIER.z ± 1.42). `pilingRadius` is the mean (≈ 0.175 m; real ones vary 0.155–0.195 m and
  bulge a little). Collide with radius + body.
- Jumping off the end: the tip has a closed rail (no ladder). If B1 wants the jump, ask; an
  opening + ladder is a small change in `plan.ts`.

## For water / breaking waves (A7, A8)

- **Caustics hook.** If `ocean.gpu.pierCaustics` is a function `(worldPos: vec3) => float`
  (mean ≈ 1, the reflected-light pattern at the water point under a surface) when the pier
  initialises, the pier's timber uses it instead of its own animated Voronoi web. The pier
  already traces each fragment back along the reflected sun ray to the water plane and passes
  that point, so the hook only has to evaluate the pattern there.
- **FFT height.** Foam collars add `ocean.gpu.surface.fftDisplacement(xz, 0.08, depth, 3).y` to
  the CPU `sample().height`, so they ride the chop. If `sample()` ever starts including FFT
  detail on the CPU, tell A4 (the collars would double it).
- **Whitewater at the pilings.** Spray fires when `sample().breaking > 0.25` at a piling (or the
  flow past it exceeds 1.4 m/s). A8: nothing else is needed; make `breaking` true near the bore.
  `pier.surge` (debug) fakes a bore marching shoreward to preview it.
- The pier writes, for every wet piling (64 of them): `SPLAT_FOAM` just downstream every 4th
  frame with the accumulated dt (rate `pier.foamRate` × (0.25 + 1.1·speed + 4·breaking), as
  `1 − e^(−rate·dt)`), and, only in real flow (> 0.7 m/s), a small `SPLAT_WAKE`. The pier updates
  after `state` in `systems.ts`, so its splats land the next frame (fine for a continuous emitter).
- Ocean sampling: `sample()` costs ~35 µs, so the pier re-samples 6 pilings per frame round robin
  (`pier.samples`) and extrapolates the rest with the sampled vertical velocity; everything is
  re-sampled after a time jump.

## Spray API (for vfx/spray, A8)

`createSprayPool(sunDir, sunRadiance, sky, noise)` → `burst(x, y, z, vx, vy, vz, count, spread,
radius, mist)`, then `step(renderer, dt, t)` once per frame. 4096 particles, ≤ 24 bursts per
frame, three fixed populations (mist 15 %, foam chunks 40 %, droplets 45 %). Bursts go into a
small storage buffer (a `uniformArray` only refreshes at render time, which breaks when the sim
is stepped several times per render). Sprites write their own screen velocity to the `velocity`
MRT and alpha-test their empty corners, otherwise motion blur tiles smear. If A8 ships a shared
pool with the same shape, the pier can drop this one.

## Params (F1 → pier)

`pier.visible`, `pier.bleach`, `pier.sprayDark`, `pier.caustics`, `pier.bounce`, `pier.aniso`,
`pier.normal`, `pier.growth`, `pier.barnacles`, `pier.fx`, `pier.collars`, `pier.foamRate`,
`pier.wakeRate`, `pier.sprayRate`, `pier.current`, `pier.surge` (debug).

## Shots

`pier-silhouette`, `pier-under`, `pier-deck` (shared) and `pier-under-water`, `pier-piling`,
`pier-rail`, `pier-stairs`, `pier-down`, `pier-spray` (use `--advance 2`).
