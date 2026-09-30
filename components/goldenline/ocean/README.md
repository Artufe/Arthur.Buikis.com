# ocean/ — swell, FFT sea, clipmap surface, `OceanService`

Owner: A2 (ocean simulation). `ocean/breaking/` is reserved for A8. Everything here is live in
`/surf`. Read this before building on the surface (A7 water shading, A8 breakers, A6/B1 floating
and riding).

## What is simulated

The surface is **groundswell + wind sea**:

| part | where | what |
|---|---|---|
| groundswell | `swell.ts` (CPU) / `swell-gpu.ts` (GPU) | 3 long-period trains (12 s, 13.7 s, 8.6 s), Gerstner with depth-aware shape. **Exact on the CPU.** |
| wind sea | `spectrum.ts` + `fft.ts` | JONSWAP + Mitsuyasu spreading, 4 FFT cascades (233 / 41.7 / 7.13 / 1.37 m patches, 256²): long wind sea → metre waves → chop → capillaries. The short two follow the local offshore breeze. |
| surface | `surface.ts` | camera-centred geometry clipmap, 13 levels, 6 cm spacing at the camera, geomorphed seams, one draw. |

The swell is baked at boot over the break (`FIELD`: x −600…40, z −440…440, 2 m texels) from the
seabed (`world/seabed.ts`, also A2's):

- **phase** from the eikonal `|∇T| = 1/c(h)` (fast sweeping) → refraction and wavelength
  compression fall out of it;
- **amplitude** `K` = shoaling × refraction from energy-flux conservation along the rays (with a
  little lateral diffusion standing in for diffraction);
- **sets**: group arrival time `τ` along the same rays, so a set's envelope travels at the group
  speed. Set schedule: 3–5 waves per set, `SWELL.setIntervalS` average, lulls between (baked
  envelope texture, one row per train, 4096 s cycle);
- **breaking history**: `Q = max upstream K/h`. A wave of offshore amplitude `a` has broken once
  `2aQ > γ_b` (0.78); broken waves saturate to `γ_s·h` (0.46) — the reef flat carries bores, the
  lagoon small reformed waves.
- Shape: shallow-water elliptical orbits (`B = A/tanh kh`), and as the wave nears the breaking
  index `kB → 0.4`, a forward-pitched face (`skew`) and a second harmonic (peaked crest, flat
  trough). Everything is shaped from the seabed smoothed over σ ≈ 7 m and breaking saturation
  develops over 18 m, so the parametric surface never folds (finite-difference Jacobian checked
  over a whole set). A set wave reaches ≈ +1.0 m crest / 1.6 m face on the reef edge, then
  ≈ 0.4 m bores on the flat. `world/seabed.ts`: flat ~30 m floor up to a steep reef front (so the
  swell arrives unrefracted and peels), reef flat at ~1.6 m with bommies, lagoon ~2.2 m, the
  pier channel.

Time is carried as integer ticks (`TICKS = 2^24` per 4096 s) and every ω is a multiple of
2π/4096 s, so all phases are exact on the GPU (u32 wrap-around) and the CPU.

## `OceanService` (CPU, zero-alloc)

- `sample(x, z, out)` → height, normal, particle velocity, `breaking`, `depth` (water column,
  from the baked still-water depth). Newton-inverts the horizontal (choppy) displacement, so the
  height is the rendered surface **at world XZ**. Swell exact; wind sea = 1900 strongest modes
  (256 of them also give slopes/velocity). Verified against the GPU vertex displacement:
  **≈ 1.0 cm RMS, 3.6 cm max** (1536 probes over 6 sites incl. the break zone). Cost ≈ 27–33 µs/call
  + ≈ 0.1 ms once per frame on the first call (mode phases). Normals include the wind sea — smooth them yourself for a board.
- `gpu.sampleCoarse(x, z, out)` — same, but only the swell + 256 strongest sea modes (≈ 2–3 cm
  RMS, about half the cost): for foam/spray triggers and anything sampled many times per frame.
- `wave(x, z, out)` → the dominant swell train's nearest crest: `dirX/Z` (local wave direction,
  refracted), `crestDistance` (m, negative = in front of the face), `faceHeight` (2A, m),
  `stage` (0 deep → 1 at the breaking index or once broken), `peelX/Z` + `peelSpeed` (along the
  crest toward deeper water, `c/tan β`, capped 30 m/s), `hollowness = 0` (A8 fills it).
- `swellDir` — SWELL's direction (deep water).
- `gpu` — below.

Per-train CPU data (A8): `trainAt(gpu.cpu.field, gpu.cpu.env, tr, x, z, gpu.cpu.rt, out)`
from `swell.ts` fills a `TrainPoint`: `theta` (θ = S − ωt, crests at θ ≡ 0 mod 2π, θ increases
along the travel direction), `kx/kz` (local wavevector, rad/m), `amp` (local amplitude after
sets and saturation), `ampUnbroken`, `ampOffshore`, `broken` (0-1), `omega`, `depth`
(smoothed, σ ≈ 7 m). A8's breaking criterion: `ampUnbroken / (0.5·GAMMA_BREAK·depth) → 1`; the
base surface saturates smoothly past it (never folds: `k·B·(1+skew) ≤ FOLD_LIMIT`).
`evalSwell(...)` gives the summed Gerstner displacement/derivatives/velocity. Constants:
`GAMMA_BREAK`, `GAMMA_SURF`, `TRAIN_DEFS`, `FIELD`.

## `ocean.gpu`

```ts
gpu.mesh          // Mesh, identity transform, frustumCulled=false, receiveShadow, never casts
gpu.material      // the placeholder (MeshBasicNodeMaterial) — replace it
gpu.surface       // OceanSurface (surface.ts):
  .positionNode   // assign to your material.positionNode (it also writes positionPrevious)
  .normal()       // fragment: world normal, swell (varying) + all 4 cascades (mipmapped)
  .derivatives()  // fragment: { dd: vec4(∂Dy/∂x, ∂Dy/∂z, ∂Dx/∂x, ∂Dz/∂z), dxz } (world)
  .jacobian()     // fragment: det of the horizontal displacement Jacobian (<1 compressed, <0 folded)
  .vRest          // varying vec2: rest (undisplaced) XZ — sample anything periodic with this
  .vSwellD        // varying vec4: swell (+hook) derivatives only
  .vSwellX        // varying vec4: (∂Dx/∂z swell, swell brokenness 0-1, smoothed still-water depth m, vertex spacing m)
  .fftDisplacement(xz, spacing, depth)   // vertex-style FFT displacement at any rest point
  .addHook(fn)    // vertex-stage extension (A8), see below
  .uFftGain       // 0/1: the ocean.fft toggle
gpu.fft           // { disp, deriv: StorageArrayTexture (256², 4 layers, rgba16f, full mip chain,
                  //   repeat), cascades: CASCADES (L, kLow, kHigh, rot), size, uChop, uGain }
gpu.swell         // { field (DataArrayTexture, 2 layers/train), envelope (DataTexture),
                  //   uniforms {phase, time, scale, skew, amp}, grid: FIELD, trains, omega }
gpu.cpu           // { field, env, rt, spec, sea } — for trainAt()/evalSwell() on the CPU
```

Texture layouts (cascade frame, see `CASCADES[c].rot`; `surface.ts` rotates back to world):

- `disp` layer c: `(λ·Dx, Dy, λ·Dz, λ·∂Dx/∂z)`
- `deriv` layer c: `(∂Dy/∂x, ∂Dy/∂z, λ·∂Dx/∂x, λ·∂Dz/∂z)`
- uv = `R(−rot)·rest / L + 0.5/256`. Cascade c's FFT sea is faded by depth with
  `FFT_DEPTH_FADE[c]` (the long cascade fades out below ~8 m, the short ones at the shoreline).

### A7: putting a real water material on it

```ts
const s = ctx.services.ocean.gpu.surface as OceanSurface;
const mat = new MeshBasicNodeMaterial(); // or any node material
mat.positionNode = s.positionNode;       // required: displacement + motion vectors
mat.side = DoubleSide;                   // crests can fold (J < 0)
mat.fog = false;                         // and call atmosphere.applyFog(...) yourself
mat.colorNode = Fn(() => { const N = s.normal(); ... })();
(ctx.services.ocean.gpu.mesh as Mesh).material = mat;
```

- Anything you need from the vertex stage (depth, brokenness) is in `vSwellX`; add your own
  varyings with `varyingProperty` inside your own nodes, not by editing `surface.ts`. Its depth
  is smoothed over ~7 m (what the waves feel); for absorption use the scene depth buffer or
  `terrain.heightTexture` (exact 1 m seabed).
- The derivative mips are box-filtered slopes: at distance the normal detail averages out, so
  raise roughness with distance (or derive it from `|avg normal|`) for a stable glitter path.
- Jacobian foam: `saturate(threshold − s.jacobian())`; the capillary cascade folds easily, so
  weight by the long cascades or use `derivatives()` yourself.
- The FFT sea's motion vectors are "static for one frame" (the swell's are exact); keep that in
  mind if TRAA ghosts the chop.
- `receiveShadow` is on; don't make the ocean cast.

### A8: blending breakers into the surface

```ts
s.addHook(({ rest, disp, dispPrev, spacing, depth, broken }) => ({
  d: breakerDisplacement(rest),          // vec3 to ADD (vertex stage, band-limit to ≥ 4×spacing)
  dPrev: breakerDisplacementPrev(rest),  // optional, previous frame (motion vectors)
  dd: vec4(...), dxz: ...,               // optional slope terms so the normals follow
}));
```

A hook also gets the swell's own part (`swell: { d, dPrev, dd, dxz }`), so it can replace the swell
instead of adding to it: the surf zone (`ocean/surfzone`, `ocean.gpu.surfzone`) does that over the
lagoon and the beach, where one shallow-water simulation is the surface.

Hooks run when the shader is built; register in `init()` (after the first compile, set
`mesh.material.needsUpdate = true`). To make `sample()`/`wave()` include the breaker, wrap the
service: keep a reference to A2's, install yours in `ctx.services.ocean`, add your part on top
(the base `sample()` already inverts the choppy displacement; do the same for yours).
The GPU mirror of `trainAt` is `swellTrainGPU(g, tr, restXZ)` in `swell-gpu.ts`.

## Params (F1 → ocean)

`ocean.enabled`, `ocean.fft`, `ocean.swellHeight`, `ocean.setInterval`, `ocean.lull`,
`ocean.period`, `ocean.swellDir`, `ocean.skew`, `ocean.windSea`, `ocean.seaWind`,
`ocean.localWind`, `ocean.chop`, `ocean.choppiness`, `ocean.sunSpec` (placeholder),
`ocean.view` (debug: 1 normals, 2 brokenness/depth, 3 height, 4 slope,
6 mip check), `ocean.debugGain`. Spectrum / envelope / field rebakes are debounced off the param
listener, never inside `update()` (a field rebake takes ~0.6 s).

## Debug hooks (dev only, allocate)

- `ocean.gpu.probeCompare(x, z, r)` — CPU `sample()` vs GPU vertex displacement on a 16×16 grid.
- `ocean.gpu.benchFFT(n)`, `ocean.gpu.benchRender(n, w, h)` — GPU timestamp costs.

## Cost (Apple M3, shared GPU, timestamp queries)

FFT (both passes + compute mip chain, 10 dispatches, one compute pass): ≈ 0.15–0.25 ms.
Surface render alone at 1280×720: ≈ 0.4–1.2 ms depending on view (170 k vertices, ~330 k tris).
CPU `update()`: ≈ 0.15–0.3 ms (mostly three's per-dispatch binding updates).
