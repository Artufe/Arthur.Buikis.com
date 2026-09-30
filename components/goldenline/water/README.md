# water/ — the water material, caustics, the reusable water graph (A7)

Owner: A7. Everything here is procedural (no third-party assets). Live in `/surf`.

| file | what |
|---|---|
| `index.ts` | the `water` system: params, uniforms, material swap onto `ocean.gpu.mesh`, the hooks it publishes, per-frame sync |
| `material.ts` | `WaterMaterial` (NodeMaterial + custom lighting model): reflection, refraction + Beer–Lambert, body in-scatter, SSS, glitter, foam |
| `slopes.ts` | fragment slopes from the 4 FFT cascades (slick weights, flow-advected capillaries, lost-variance roughness) |
| `variance.ts` | CPU table: slope variance each cascade's mip chain filters away, per level (the glitter roughness) |
| `glitter.ts` | stochastic sun glints: rest-space cells, facets drawn from the unresolved slope distribution, mean-preserving |
| `refraction.ts` | one mid-pass copy of scene colour + depth, normal-driven refraction, exact seabed depth from `terrain.heightTexture` |
| `thickness.ts` | vertex hook: the SSS light path and the crest chord; the SSS provider registry for breakers |
| `foam.ts` | multi-layer foam from `state.foam()` (fresh sheet → lace → specks), relief, bubble glints |
| `caustics.ts` | seabed caustics (beach hook) and pier-underside caustics, from the surface Hessian |
| `hessian.ts` | compute: per-cascade world Hessian of the FFT surface with mips (2 dispatches/frame) |
| `occluder.ts` | depth-only copy of the surface drawn first where the seabed can't be seen (culls its shading) |
| `textures.ts` | boot-time foam (hole field, bubbles, density) and noise textures |
| `testcrest.ts` | debug fixture: a steep crest for judging SSS until A8's breakers exist (`water.testCrest`, boot) |

## How it shades (per pixel)

- **Reflection**: exact Fresnel, sky from `atmosphere.skyRadiance(R)`. The reflection vector is lifted by
  the unresolved slope σ (rough facets reflect higher, darker sky). SSR opt-in with the weight given to
  the sky; SSR is faded past `water.ssrFade` and for rays skimming the surface (`water.ssrGrazing`).
- **Refraction**: the scene behind the water (seabed, reef, pilings) displaced by the screen motion the
  wave normal causes vs a flat surface; occluders (pilings, board) in front of a displaced sample shrink
  the displacement. Restrained dispersion (R/B with their own index). Absorption per channel along the
  refracted path, with the seabed depth at both ends of the ray, plus the sun's leg down to it.
- **Body**: single-scatter reflectance of the water column (`b_b/(a+b_b)`, in-water phase angles), more
  particles over the shallows (`water.lagoon`), bubble cloud under fresh foam. Turquoise over sand →
  teal over reef → sapphire in the deep emerges from these, not a ramp.
- **SSS**: sunlight crossing a crest toward the viewer: `σs·w·e^{−(σa+σs)w}` per channel, forward-peaked,
  gated to faces steeper than the refracted sun. Crests seen edge-on against the sky transmit it along
  the crest chord (`water.throughPath`).
- **Glitter**: GGX with roughness² = base² + the slope variance the FFT mips averaged away at this pixel
  (so the path is continuous and stable at any distance), soft knee on the peak channel, then stochastic
  glints that redistribute that energy into sparks (`water.glint*`), with a separate spark roll-off.
- **Foam**: `state.foam()` coverage/age drive a thresholded hole field (fresh bubbly sheet with pinholes →
  lace → specks), shaded as a volume of bubbles with a wet sheen and bubble-rim glints.
  The foam tiles are domain-warped (two octaves, ~1.4 m at ~10 m): where coverage sits in the lace
  range for a while (the surf zone) the web repeated on its tile and read as a lattice of crosses.
  Inside the surf zone its own foam (carried by the simulated flow) adds to the state's.
- **Micro-detail**: capillary cascade flow-advected by drift + wake velocity (two-phase flow map),
  wind slicks damp the short cascades, `state.wake()` height adds normals near the camera.
- Sun shadows arrive through the lighting model (the pier's shadow darkens glitter, SSS and body);
  beyond 220–420 m the water ignores them (the far cascade breaks distant shadows into patches).

## For A8: breakers, whitewater, the tube

```ts
const water = (ctx.services.ocean.gpu as any).water as WaterApi; // set in water's init()
const mat = water.createMaterial({
  rest,        // vec2 XZ the foam/state and FFT detail are sampled at (default positionWorld.xz)
  depth,       // water depth below (m) — drives the seabed fade / lagoon (default 3)
  broken,      // 0-1 (default 1)
  thickness,   // vec4(SSS path m, steepness 0-1 (or −1: from the normal), wave dir x, z)
  chord,       // float: horizontal chord through the lip at this point (m)
  baseNormal,  // world normal of YOUR geometry (default normalWorld); FFT detail is added on top
});
mat.positionNode = yourPositionNode;     // + positionPrevious for TRAA/motion blur
mesh.renderOrder = water.renderOrder;    // after the other opaques, before the sky dome
```

- `thickness`/`chord` are what make a lip glow: thin lip → short path → gold; thick base → green, then
  opaque. Give them per vertex (varyings) from your profile. The tube ceiling seen from inside is the
  lip's back face: it works the same way (DoubleSide; the normal flips toward the viewer).
- **Blended into the ocean surface** instead (surface hook): register an SSS provider so the ocean's own
  material knows your path — push into `water.sssProviders` (= `ocean.gpu.waterSSS`) in your `init()`:
  `({ rest, disp, … }) => ({ path, steep, chord })` (vertex stage, same input as a surface hook;
  `chord ≥ 1e3` = not active here). The water registers its thickness hook in `warmup()`, after all
  inits, so your displacement is already in `disp`.
- Foam from whitewater: write `SPLAT_FOAM` into state (A5); the material reads coverage/age. The swell /
  chop Jacobian foam terms exist (`water.whitecaps`, `water.boreFoam`) but default to 0.
- The refraction copy is shared: the first water draw per frame copies the scene; breakers drawn after
  the ocean refract the scene without the ocean (fine for a lip over the face).
- Tunables worth touching once real lips exist: `water.sss`, `water.sssScatter`, `water.sssForward`,
  `water.throughPath`, `water.lagoon`.

## Hooks it publishes (set in `init()`)

- `setCausticsHook(...)` (beach/hooks.ts): seabed caustics, the modulation of the direct sun
  (mean ≈ 0): 1/|det(I + D·M·H)| of the refracted sun through the real surface Hessian, blurred with
  depth, faded by depth and distance, shadowed by the pier deck.
- `ocean.gpu.pierCaustics(worldPos) → float` (mean ≈ 1): the same with the reflected ray (A4 reads it).
- `ocean.gpu.water`, `ocean.gpu.waterSSS`: above. `ocean.gpu.swellGPU`: the `SwellGPU` (one additive
  line in `ocean/index.ts`), so hooks can call `swellTrainGPU`.

## Render order and cost notes

- The water is opaque at `renderOrder 1e5`: after every other opaque (its copy must hold the seabed),
  before the sky dome (`1e6`, which only shades far-plane pixels). In the transparent list the dome
  would shade every pixel behind the water (≈ 5 ms at 1440p on the M3).
- The seabed under the water is now shaded (the placeholder hid it). Where it can't be seen (smoothed
  depth > `water.deepCull`, distance > `water.farCull`) `occluder.ts` culls it.
- Colour and depth are copied under one render-pass break (three's viewport nodes break the pass once
  each; on a tile GPU each break stores and reloads every MRT attachment).
- The ssr MRT channel's `z` is 1 on water pixels: the SSR composite can reject hits on the water itself.

## Params (F1 → water)

Look: `absorb`, `scatter`, `turbidity`, `lagoon`, `seabedGain`, `sss`, `sssScatter`, `sssForward`,
`sssFloor`, `throughPath`, `glitter`, `glitterKnee`, `glintAmount`, `glintCap`, `glintSize`, `glintCells`,
`glintTau`, `roughness`, `varScale`, `reflection`, `horizonLift`, `refraction`, `dispersion`, `caustics`,
`causticDepth`, `causticBlur`, `pierCaustics`, `foam`, `whitecaps`, `boreFoam`, `slicks`, `micro`.
Pipeline: `enabled`, `cull`, `deepCull`, `farCull`, `ssrFade`, `ssrGrazing`.
Debug: `debug` (1 SSS path/steepness/face, 2 foam, 3 refraction path, 4 roughness, 5 refracted colour,
6 normal, 7 transmittance, 8 shore/through, 9 SSR weight, 10 refraction classes, 11 glints,
12 seabed visibility / exact depth / smoothed depth),
`debugGain`, `foamTest` (coverage × age ramp at x −22…−12, z 9…19; shot `water-foamtest`),
`testCrest` (boot; shot `water-crest`), `ablate` (boot; cost-ablation bitmask: 1 refraction, 4 glints,
8 foam, 16 wake, 32 shadows, 128 depth copy).

## Shots (lab/shots.ts)

`water-shallows`, `water-glitter`, `water-foam`, `water-foamtest`, `water-crest` (boot with
`--p water.testCrest=1`). Params persist between shots in one shot-tool run: put `water-foamtest` last.
