# ocean/breaking/ — breaking waves, whitewater, shore break, swash (A8)

Owner: A8. Driven from the ocean system (`ocean/index.ts` calls `createBreaking` in `init`, then
`warmup` / `update` / `rebake` / `dispose`; every line there is marked `[breaking]`). Everything is
procedural; no assets. The shared spray system lives in `vfx/spray/` (also A8).

## How it works

| file | what |
|---|---|
| `rays.ts` | Two ray fans baked at boot from A2's swell field: the **reef fan** (336 rays marched shoreward along the refracted train-0 direction, 1 m steps: phase S, shoaling K, group time τ, depth, cumulative K/h for the breaking onset, plunge per ray from the seabed slope at the break) and a uniform **shore fan** (300 straight rays across the beach face: the reef focuses the reef fan away from the beach behind it). Plus a ray-label field on the swell grid (GPU hook lookups). |
| `profile.ts` | The breaker cross-section through its whole life as a keyframe table: 128 profile points × 96 stages (φ = time since onset in √(H/g), −4 … 19.75) × 3 plunge levels (spill … barrel). Steepening face → nose pitches → ballistic jet (launch velocity, gravity) with a rounded tip → the lip lands → tube holds → collapses into a rolling bore that decays. Point j keeps its identity through the life, so interpolating keyframes is a smooth morph. Tables: (u, y, SSS path, chord), (foam, rest σ, blend W, tube), (texture σ). |
| `tracker.ts` | Per frame (0.04 ms): crest n of train 0 is `S = phase + 2πn` on every ray at once; its breaking onset for *its own* offshore amplitude (set envelope at its group time) is a binary search on the cumulative K/h; φ follows from the phase difference. 6 reef slots + 3 shore slots (crest n → slot n mod k). Fades at stage jumps (reef ends), smooths φ along the crest, folds trains 1–2 into the height, writes one RGBA32F data texture (336 × 37). |
| `gpu.ts` | The data texture, label field and profile 3D textures + TSL accessors. |
| `ribbon.ts` | The breaker geometry: 9 × (288 along the crest × 128 profile points), one draw, vertex-only (a log warp puts the densest columns at the camera). Profile in the crest frame, blended into the full swell at the edges (+ the FFT sea everywhere), real normals, varyings for A7's water graph (SSS path, chord, foam, tube). The same grid drawn a second time as the **whitewater shell** where the profile is foam: pushed out, cauliflower billows (billow noise), stock PBR + a forward-scattering lobe (`whitewater.ts`). |
| `hook.ts` | The ocean surface's vertex hook: under a breaker the clipmap surface drops out of the way (face / trough / landing zone deep, the back slope 12 cm), so the ribbon is the only surface there. |
| `whitewater.ts` | Shell material: bubble-cluster bump (baked tileable billow texture, two scales, rolling), crease darkening, translucent glow, ragged alpha-tested edges. |
| `emit.ts` | CPU whitewater effects per crest column: offshore spray **veils** off steep crests (streaming seaward on the breeze), **drips** off the thrown lip, the **impact** explosion (clumps, droplets, mist), **smoke** off the roller, and **foam** splats into the state (`SPLAT_FOAM`, bulk path). |
| `swash.ts` | 1-D swash along the shore (0.5 m): a shore-break bore reaching the waterline launches an uprush (u₀ = 2.2·√(g·h_bore)), ballistic up the local slope, stall, slower backwash, thinning to a film; neighbours launch with slightly different speeds and times (lobed, fingered front). A camera-following sheet mesh draped on the sand (C2 B-spline of the terrain bake), shaded with A7's water graph (transparent over the sand, refraction, bubble line + lace foam at 3.4× scale). The state it uploads is smoothed along the shore (binomial, σ ≈ 0.7 m) so the reach varies in rounded lobes. Writes `SPLAT_SMOOTH` and `SPLAT_FOAM` along the front; publishes `ocean.gpu.swash.wet(xz, edge)` (1 under the sheet), from which the state kernels wet the sand. |
| `service.ts` | Wraps A2's `OceanService`: `sample()` / `gpu.sampleCoarse()` include the breaker, `wave()` returns live breaker data, `gpu.breaking.breaker()` the full picture. |
| `train.ts` | Zero-alloc train evaluation (= swell.ts `trainAt`, verified to 1e-16) with doubles in a typed array. |

### The wave

`ocean.swellHeight` 1.8 (was 1), `ocean.swellDir` +18°, `ocean.setInterval` 90 s, train-0 lull 0.42
(`swell.ts`): set faces 2.6–3.4 m at the peak, ~1.4 m between sets. The peak barrels (plunge 1 over
the reef front), the section toward the pier throws on the reef flat, the channel never breaks
(checked over 400 s), the north sand shelf spills. Peel ≈ 14–23 m/s toward +Z, a short left toward −Z.

## For B1 (surfing)

```ts
const ocean = ctx.services.ocean;              // read every frame (A8 installs a wrapper in init)
ocean.sample(x, z, s);                         // ridable surface: face / tube floor / trough (never the lip overhead)
ocean.wave(x, z, w);                           // stage, dir, peel dir + speed, crestDistance, faceHeight, hollowness
const brk = (ocean.gpu as any).breaking as BreakingApi;   // service.ts
brk.breaker(x, z, bp);                         // bp = newBreakerPoint(), reuse it
```

- `sample()`: `height` is the breaker's ridable surface where one is (weighted into the swell across its
  footprint), `nx/ny/nz` its normal, `vx/vy/vz` the water velocity (shoreward in the face, ~c·η/h), and
  `breaking` = whitewater coverage (0 on the clean face, 1 in the soup). ≈ 10–14 µs per call on the M3 in a
  breaker, ≈ A2's cost elsewhere. `gpu.sampleCoarse` too.
- `wave()`: `stage` (0 → 1 as it steepens, 1 once broken), `peelX/Z` (along the crest toward the unbroken
  shoulder), `peelSpeed` (m/s, from how fast the onset sweeps the crest), `crestDistance` (m, negative = in
  front of the face), `faceHeight` (m), `hollowness` (1 = an open barrel).
- `breaker()` (`BreakerPoint`, service.ts): `active`, `phi` (stage in √(H/g) units; `Ts` s per unit), `kappa`
  (plunge), `H`, crest point `cx/cz`, wave dir `dx/dz`, phase speed `c`, `u` (m ahead of the crest),
  `crestY` / `troughY`, peel, `tube` (0-1 open barrel here) with `tubeX/Y/Z` + `tubeR` (the barrel's interior
  centre and radius: steer the stall there), and the lip tip `lipX/Y/Z`.
- Stage timeline of a plunging set wave (φ; × `Ts` ≈ 0.55 s): steepening −4 … 0, lip launch 0.45, impact 2.2,
  tube open ≈ 0.9 … 3.1, collapse 3.1 … 5.5, bore to 19.75. `stageTimes(kappa)` in profile.ts.
- Everything is zero-alloc inside; the call itself boxes its double arguments at a call site V8 doesn't
  inline (V8 behaviour), so keep hot loops' calls few. `ocean.gpu.breaking` is the API object; don't cache
  `ctx.services.ocean` before A8's init has run (it's replaced there).

## Spray API (`vfx/spray/`, for B1 and A4)

```ts
const spray = (ctx.services.ocean.gpu as any).spray as SprayService;
spray.burst(x, y, z, vx, vy, vz, count, spread, radius, mist); // same signature as pier/spray.ts
spray.emit(SPRAY_DROPLET | SPRAY_MIST | SPRAY_FOAM | SPRAY_VEIL, x, y, z, vx, vy, vz, count, spread, radius, size, life, waterY);
// zero-alloc bulk path for heavy emitters:
const o = spray.reserve(kind, count | 0);        // float offset into spray.emitData, or -1
if (o >= 0) { const d = spray.emitData; d[o] = x; d[o + 1] = y; d[o + 2] = z; d[o + 4] = vx; d[o + 5] = vy; d[o + 6] = vz;
  d[o + 8] = spread; d[o + 9] = radius; d[o + 11] = size; d[o + 12] = life; d[o + 13] = waterY; }
```

32 k particles, one compute dispatch (idles 5 s after the last emitter), one instanced sprite draw.
Kinds: droplets (ballistic, velocity-stretched), mist (buoyant, drifts on `spray.wind`, barely dims what's
behind it), foam clumps (heavy, lumpy puffs from a baked atlas, self-shaded), veils (wind-blown, stretched).
All forward-scatter the sun (they glow backlit). ≤ 256 emitters per frame. `waterY` kills droplets/clumps
that fall back through the water. `spray.wind` is the offshore breeze by default. The owner (A8) calls
`step()` every frame; others only emit. Particles don't cast shadows (sprites can't; B1's fan shadow needs
a shadow-casting proxy — ask A8/B2 if you need a hook).

## For A4 (pier)

- Whitewater at the pilings: the shore-break bores reach the pilings at the pier root (x ≈ −4 … 4);
  `sample().breaking` is the whitewater coverage there, so the existing spray trigger fires. The reef bores
  don't reach the pier line (the channel is deep).
- `ocean.gpu.spray.burst()` has `pier/spray.ts`'s signature: the pier can drop its own pool.

## Params (F1 → breaking)

`enabled`, `hide` (debug), `plunge`, `timeScale`, `gammaShore`, `edgeDrop`, `warp`, `lipGlow`, `lipDiffuse`,
`streaks`, `faceTexture`, `whitewater`, `wwAlbedo`, `wwTranslucency`, `wwRagged`, `spray`, `veil`, `smoke`,
`foam`, `swash`, `runup`, `swashFoam`, `debug` (1 stage colours, 2 normals, 3 blend/tube/SSS path, 4 foam).
The swell itself: `ocean.swellHeight`, `ocean.swellDir`, `ocean.setInterval`, `ocean.lull`.

## A7 water-material inputs added (all optional, `[breaking]` in water/)

`foam` (extra coverage/age), `baseTangent` (sea slopes in the breaker's surface frame), `foamScale`,
`foamStateGain` (no state foam inside the tube), `underReflect` (a downward-facing lip mirrors the barrel,
not the sky), `sssTexture` (chop facets modulate the backlit glow), `sssDiffuse` (isotropic multiple
scattering in thin lips, not gated by the backlit-face term).

## Shots

`breaking-peel` (M3 gate, `--seq 30 --interval 2` from t = 30), `breaking-tube` (`--advance 0.5`),
`breaking-front`, `breaking-shoulder` (`--advance 1.5`), `breaking-swash` (`--advance 2.8` or `--seq 12
--interval 0.5`). The first set reaches the peak at t ≈ 38–56 s; lulls around t ≈ 60–100 s.
