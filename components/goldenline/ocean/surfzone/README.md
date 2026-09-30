# ocean/surfzone/ — the lagoon, the shore break and the swash as one simulation

One shallow-water simulation carries every wave from the lagoon to the top of its run-up: waves
steepen into bores, break, run up the beach face with their own momentum, stall and drain back.
It replaced three systems that each played part of a wave (the lagoon swell that flattened at the
waterline, a canned shore-break profile that faded before the sand, and a 1-D ballistic swash that
launched on thresholds), which is why waves used to "break, hit the shore and stop".

| file | what |
|---|---|
| `grid.ts` | the domain and every constant: x −46 … 22 m at 0.25 m, z −260 … 180 m at 0.5 m (272 × 880 cells), relaxation zone, approach band and gain, substep, readback window |
| `scheme.ts` | the method on the CPU, the reference the kernels mirror; `scheme.spec.ts` tests it |
| `kernels.ts` | the GPU kernels: bake, momentum, continuity + relaxation, foam, pack, readback window |
| `index.ts` | `createSurfZone`: the surface hook, `foamAt` / `wet` for the water material and the state, stepping and spin-up, readback → `sampleInto`, spray off the fronts |

## The method

Nonlinear shallow-water equations on a staggered grid (Stelling & Duinmeijer 2003): depth `h` and
bed `b` at cell centres, `u` on x-faces, `v` on z-faces, `η = h + b`.

- Face depths are upwinded (η of the upstream cell minus the higher bed): well-balanced (a lake at
  rest stays at rest over any bed), non-negative depths under CFL, flooding and drying with no special
  cases.
- Advection is momentum-conservative (`q·∂u/∂x = ∂(qu)/∂x − u·∂q/∂x`), so bores travel at the
  Rankine–Hugoniot speed: a broken wave keeps its momentum.
- Manning friction (implicit), `surfzone.friction`.
- Breaking (Kennedy et al. 2000): where the surface rises faster than 0.3·√(gh), an eddy viscosity
  ν = 1.44·h·∂η/∂t in momentum-conservative form (it dissipates energy, never brakes the bore), off
  in water shallower than 0.1–0.3 m (at a thin run-up tip √(gh) → 0 and it would brake the uprush),
  capped at a quarter of the explicit-diffusion limit. `surfzone.breaking`.
- Infiltration into the sand above sea level, 4 mm/s (`surfzone.soak`): the upper beach dries
  between waves and the backwash is weaker than the uprush.

Tests (`scheme.spec.ts`): lake at rest over a bumpy bed with a dry island, mass conservation, a wet
dam break against Stoker's bore speed and middle depth, a dry dam break against Ritter's front speed
with no negative depths, a bore running up a 1:8 beach and draining back, breaking dissipating
without braking the uprush, a swash film soaking away, x/z transpose symmetry.

## Boundaries and forcing

- **Seaward edge, 16 m relaxation zone** (x −46 … −30): the state is nudged toward the incident swell
  at 12/s × a quadratic ramp. That both makes the waves and absorbs what the beach reflects. The
  incident is the swell's train sum, Eulerian (one fixed-point step back along the Gerstner
  displacement), with depth-averaged velocity from the wave's volume flux `(h + η)·u = c·η`. (Dividing
  by the still depth instead pumped each wave's Stokes transport into the domain: the beach flooded.)
- **Lagoon gain** (`surfzone.gain`, 0.5): the swell arriving here is the unbroken train sum, up to
  1.7 m during a set in the 2.3 m lagoon; real waves lose most of that crossing the reef flat. The
  swell is scaled over a 30 m approach band ending at the seaward edge (rendered surface and CPU
  sample alike) and the simulation is driven with the scaled swell.
- **Along-shore ends**: 16 m sponges toward the incident, so nothing reflects off the grid's sides.
- **Landward edge** x = 22 m: a wall at ~2.3 m, above any run-up.

Reef breakers (`ocean/breaking`) fade out over the 14 m before the seaward edge; the simulation
takes every wave from there.

## Rendering

The ocean mesh draws it: a surface hook (`hook`, registered in the ocean's init) replaces the swell
inside the domain with the simulation, blending over the inner half of the relaxation zone. Deep
water uses the simulated free surface; thin water (< 0.5 m) is draped on the rendered base terrain
(the same B-spline the beach draws, so a 1 cm film sits exactly on the sand); dry cells tuck the
surface 12 cm under the sand, so the water's edge is where the depth runs out. The hook band-limits
to the vertex spacing (four taps over coarse vertices): point-sampled from the 1–2 m vertices 40 m
out, a bore front drew as a staircase. The FFT sea stays on top, faded by depth as before.

- **Foam** (`foamAt`, fed to the water material's `foam` input): generated where the surface falls
  steeply ahead of fast water (a bore) and at the thin leading edge of an uprush, carried by the
  simulated velocity (semi-Lagrangian), ~6 s on the water, ~2 s stranded on sand, aged over 12 s
  into lace.
- **Wet sand** (`wet`, the state's `wetSrc`): 1 where the simulation has water on the sand; the
  state dries it, and its `sand()` reader takes it live per pixel (state/README.md). Four loads of
  S0 rather than a filtered R0 tap: the sand material's fragment stage is at its 16 samplers.
- **Spray**: droplets off breaking fronts near the camera, from the readback window.

## CPU

`ocean.sample()` / `gpu.sampleCoarse()` are wrapped (ocean/index.ts): inside the domain and within a
32 × 32 m window around the camera (read back asynchronously every frame, two staging buffers, ~2
frames late) the height, normal, velocity, depth and breaking come from the simulation; the approach
band scales the swell as drawn. Outside the window the swell is returned (the camera is never far
from where it matters).

## Stepping

Per frame `ceil(dt / (1/118 s))` substeps (≤ 6) of momentum + continuity, then foam and pack, all
prebuilt lists, one `renderer.compute()` call. The simulation is stateful: on a time jump (> 0.5 s
off the expected clock: the shot tool, the overlay) and at boot it is reset to still water and spun
up over the 24 s before (at 1/30 s, the swell's GPU uniforms set per step), so waves are already on
the beach at the first frame.

Cost (M3, `__bench`): 0.22 ms per substep + 0.30 ms foam/pack: 0.74 ms at 60 fps. Spin-up ≈ 0.9 s
of GPU at boot and per time jump. Stable over a 10-minute run (no NaN, |u| ≤ 3.9 m/s, run-up between
x ≈ 7 and 13 m through sets and lulls).

## Params (F1 → surfzone)

`gain` (lagoon wave height ×), `friction` (Manning n), `soak` (mm/s), `breaking` (×).

## Dev hooks

`ocean.gpu.surfzone.__probe(x, z, n)` reads n cells of (h, u, v, b) along +x; `__bench(reps, n)` times
a frame's work with GPU timestamps; `stats` (frames, substeps, reads, spin-ups).
