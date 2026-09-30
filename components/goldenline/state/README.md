# Surface state & interaction (`state/`)

The shared, persistent interaction buffers from BRIEF §3.3. Writers call `ctx.services.state.splat()`;
the water and sand shaders read `foam()`, `wake()` and `sand()`. Nothing is rebuilt from event lists:
every splat is stamped once into the buffers, which then simulate (drift, decay, dry, refill) on
their own.

## Fields

| field | size | texel | window | channels (stored) |
|---|---|---|---|---|
| far  | 1024² | 0.4 m  | 410 m | foam coverage, coverage × age (drifting) · wetness, freshly smoothed (static) |
| near | 1024² ×2 | 0.1 m | 102 m | foam, coverage × age, disturbance · wake height, dh/dt, wake velocity x/z |
| sand | 2048² | 2.5 cm | 51 m  | wetness, depression, displaced mass, freshly smoothed |

All RGBA16F, ping-ponged. All three follow the **camera** (not the player), snapped to whole texels
and addressed toroidally: world texel `W` always lives at storage texel `W mod n`, so moving never
resamples anything (no swimming by construction). Texels that scroll in are re-initialised (near
fields from the far field, so foam and wetness are continuous across the boundary). Readers fade the
near field into the far one over the outer 8 % of each half-width; you never see a window edge.

Water content lives in a **drift frame**: the mean longshore current + Stokes drift (`GLOBAL_DRIFT`
in `shared.ts`, ~8 cm/s) moves it by whole texels (exact, no numerical diffusion); readers apply the
sub-texel remainder. The spatially varying part of the current (a surf-zone longshore current that
turns seaward as a rip out of the channel beside the pier) is advected with a limited Catmull-Rom
semi-Lagrangian step. Wave *orbital* motion is not simulated here: sample `foam()` at the water
mesh's **rest (undisplaced) XZ** (`ocean.gpu.surface.vRest`) and the foam rides the swell for free.

Per frame: one compute pass, three dispatches (far → near → sand). Each fetches the previous state,
simulates, then gathers the splats binned into its 32×32-texel tile (a CPU counting sort: no atomics,
no races, deterministic) and stores (with stochastic rounding, so slow processes survive f16).
Sand runs on an **active-tile schedule** (`active.ts`): only tiles with splats, tiles that scrolled
in and a rolling 1/8 slice update each frame (each integrating its own elapsed time), plus a dt = 0
sync pass the frame after. Position-only inputs (base height, wetness floor, current masks) and the
lace/value noise are baked once at init (`static.ts`, `noise.ts`).

## Writing: `splat(kind, x, z, radius, strength, dirX?, dirZ?)`

Zero-alloc: a flat write into a fixed 1024-entry Float32Array; extras in a frame are dropped.
Positions are world metres. Call it from `update()` of any system that runs **before** `state` in
`systems.ts`; later systems' splats land next frame (fine for continuous emitters). Splats outside
every window are ignored; invalid ones (NaN, radius ≤ 0) are dropped.

| kind | brush | `radius` | `strength` | `dir` | combine |
|---|---|---|---|---|---|
| `SPLAT_FOAM` (0) | domain-warped, fingered blob with a clotted rim | blob radius (m) | coverage added, 0–1 | – | `c + s·m·(1 − c)`; resets age in proportion |
| `SPLAT_WAKE` (1) | zero-mean pressure point + chevron trailing along −dir | source radius (m) | pressure depth (m), e.g. 0.02–0.05 | water velocity **in m/s** (magnitude matters; unit vector = 1 m/s). Zero = a splash (rings) | pushes dh/dt (moving) or displaces once (splash); blends velocity; max disturbance |
| `SPLAT_WET` (2) | disc | radius (m) | target wetness 0–1 (1 = standing film) | – | `max` |

The swash does not splat its wetting: it publishes `ocean.gpu.swash.wet(xz, edge)` (1 under its
sheet right now), which the far and sand kernels evaluate per texel on the beach face, so the wet
film is exactly where the water ran (lobed front, tapered ends, no discs). Use `SPLAT_WET` for
anything else that wets sand (a dripping board, a spilled bucket).
| `SPLAT_FOOTPRINT` (3) | heel, ball (bowl floors), lateral arch, five toes, displaced rim, kicked sand ahead | **half the foot length** (≈ 0.13) | depth (m) in dry sand, ≈ 0.02 | foot heading (normalised for you) | `max` depth; rim added |
| `SPLAT_SMOOTH` (4) | disc | radius (m) | fraction of relief erased, 0–1 (1 = gone) | – | multiplies depression/mass by `1 − s·m`; sets *freshly smoothed* |

Rules of thumb:
- **Continuous emitters**: FOAM and SMOOTH strengths are *per splat*, so scale them by frame time
  (`1 - Math.exp(-rate * dt)`). WET is a target level and a moving WAKE is integrated with dt
  internally, so those are frame-rate independent already.
- A moving wake of `strength` 0.035 m at 5 m/s gives ~16 mm crests (dispersive trailing train,
  ~10 s decay). Paddle stroke: WAKE r≈0.2, s≈0.03, dir = hand velocity, plus a small FOAM. Board rail:
  every frame, WAKE at the rail with the board velocity and FOAM along the rail (`strength ≈ 3·dt`).
  Breaking whitewater: FOAM discs of 2–5 m along the bore, `strength ≈ 4·dt`. Swash: SMOOTH
  (≈ 6·dt) along the run-up front, FOAM ≈ 2·dt on the leading edge (its wetting is `wet()`, above).
  The sand field only updates tiles with splats (plus a rolling 1/8), so these also keep the
  tiles under the front current.
- Left/right feet are inferred from the previous footprint (it is on the medial side), so just splat
  each footfall where the foot lands, oriented along the foot. Prints are shallower with smaller rims
  on damp sand, squeeze a pale halo into wet sand for ~1.5 s, and their hollows fill with water.
- Prefer radii ≥ one texel of the field you target (sand 2.5 cm, near water 10 cm, far 40 cm);
  smaller brushes still land, area-compensated.
- **Heavy writers (hundreds per frame)**: V8 boxes double arguments at a call site it doesn't inline.
  For zero allocations regardless of how your loop compiles, use the bulk path:
  `const o = state.reserve(k)` (float offset or -1), then write `[kind, x, z, radius, strength, dirX,
  dirZ, 1]` per splat into `state.splatData` at `o`, `o + 8`, …

## Reading (TSL)

- `foam(xz) → vec2(coverage 0–1, age 0–1)`. Age 0 = fresh, bubbly; it reaches 1 at `state.foamLife`
  (60 s). A patch holds ~5 s, opens holes into a lace network by ~12 s (holes near 0, filaments
  0.5–0.9), fragments into streaks by ~25 s, faint lace to ~40 s, gone by ~50 s. **Coverage 0.1–0.5 is
  the lace phase: map it to thin foam, don't threshold it away.** The lace scale is ~0.5–2 m near
  the camera (~4 m in the far field); add your own sub-metre bubble detail modulated by age. Sample
  at the rest position of the water surface. Foam is cleared on land above ~2 m.
- `wake(xz) → vec4(height m, velocity x, velocity z, disturbance 0–1)`. Use the height gradient
  (step `nearTexel`) for normals or displace; disturbance for micro-roughness/aeration. Zero outside
  the 102 m near window.
- `sand(xz) → vec4(wetness 0–1, depression m, displaced mass m, freshly smoothed 0–1)`.
  Wetness: 0 dry · ~0.3 damp band where run-ups regularly reach (`state.swashFloor`, cuspate) ·
  0.88 saturated in a narrow strip at the waterline (1 below it) · 1 under a swash sheet, then it
  dries in three stages: the standing film (> 0.9, a mirror; SSR) over ~`state.filmTime`, the
  saturated sheen (0.5–0.9) over ~`state.satTime`, then damp sand at 1/`state.dryTime` per second.
  Film and sheen last ~2.5× longer at the waterline and ~0.5× at 0.9 m up the face (the water
  table), so after a run-up the shine retreats down the beach toward the water.
  Water-filled print hollows get wetness ~1 **and** smoothed ~0.9 (so a film keyed on either shows).
  Depression and mass are positive metres (surface = base − depression + mass).
- Optional extras on the service (typed in `contracts.ts`): `sandHeight(xz)` = mass − depression (m),
  faded at the window edge; `sandTexel` (0.025) and `nearTexel` (0.1) for finite differences.

**Footprints must self-shadow** (BRIEF §3.3). The shadow map can't resolve a 2 cm hollow, so march the
heightfield toward the sun in the sand fragment shader: 10–12 steps of ~1.6 cm along the sun's XZ
direction, occluded where `sandHeight(p + d) − sandHeight(p) > d · tan(sunElevation)`, and feed it to
`material.receivedShadowNode`. `debug-view.ts` (relief mode) does exactly this. Normals: central
differences of `sandHeight` at ±`sandTexel`.

Readers use explicit-LOD samples (`.level(0)`), so they work in vertex and fragment stages and in
non-uniform control flow. Each call is 1–3 filtered taps.

## Params (group `state`, F1 overlay)

`state.enabled`, `state.foamLife`, `state.foamLace`, `state.surfCurrent`, `state.rip`, `state.advect`,
`state.wakeSpeed`, `state.wakeDamping`, `state.wakeDispersion`, `state.dryTime`, `state.filmTime`,
`state.satTime`, `state.swashFloor` (damp band where run-ups regularly reach), `state.refillWet`; `state.simFar` / `simNear` / `simSand` (per-field kernels, for
profiling); and the debug set:

- `state.debug` = 1 channel overlay (foam white, wake red/blue, disturbance magenta, wet cyan,
  prints orange, rims yellow), 2 lit sand relief in front of the camera with heightfield self-shadow.
  (Capture these with `--p post.motionBlur=0`: motion blur smears the debug meshes.)
- `state.debugScene` = scripted writer: footprint trails on dry (x≈41.5) and saturated sand (found
  from the live terrain), a foam patch at (−16, 14), a wake source crossing x=−9 and paddle rings; a
  swash erases part of the wet trail at +40 s and a smoothing sweep erases the far half of the dry
  trail at +66 s. Shots `state-*` in `lab/shots.ts`.
- `state.debugDolly` (m/s) slides a locked shot camera along −Z (proves the windows scroll cleanly).

Dev-only hooks on the service (installed in dev or `?shot=1`): `__probe(field, x, z, drift, w, h)`
reads texels back; `__bench(n, mask)` times the kernels in isolation with GPU timestamps;
`__allocTest(n, splats, stage)` runs the CPU side for heap profiling.
