# atmosphere/ + post/ — how other materials plug in

Owner: A1 (atmosphere, lighting, post). Everything here is live in the shared `/surf` route.

## Units and the light

- Linear HDR radiance. The sun is `services.atmosphere.sunLight`, a `DirectionalLight` with
  `intensity = 1` and `color = sunColor`. **`sunColor` is the sun's irradiance at sea level**,
  already reddened by the actual transmittance (≈ `(3.4, 2.3, 1.2)` at the default 11°,
  `atmosphere.sunIntensity` 5.5). Sunlit diffuse is `albedo / PI * sunColor * NdotL`, which is what
  stock materials do.
- `sunDir` / `sunDirNode`: unit vector toward the sun. `sunColorNode`: TSL uniform of `sunColor`
  (a `Color`). Both update live if the sun params change (F1 → atmosphere).
- Ambient is image-based: `scene.environment` is a PMREM of the same physical sky (clouds in,
  sun disc out, only 15% of the circumsolar aureole, because whatever shadows the sun shadows its
  aureole too), plus a coarse ground: sand landward, dark water seaward. Stock
  `MeshStandardNodeMaterial` / `MeshPhysicalNodeMaterial` get it for free. Custom lighting can use
  `services.atmosphere.envTexture` with `pmremTexture(tex, dir, roughness)`.
- Exposure is `core.exposure` (renderer.toneMappingExposure). Tonemapping is AgX with a look,
  applied by the post chain. Don't tonemap or gamma-encode in your material.
- Calibration targets at exposure 1: sunlit white sand ≈ 0.2–0.35 linear, sky at zenith ≈ 0.03–0.07,
  shadowed sand ≈ 1/3 of lit. Anything you add should land in that range; emissive glints that
  go above ~24 are clamped for bloom but still tonemap to white.

## Fog / aerial perspective

- Stock node materials: automatic (`scene.fogNode`).
- Custom `outputNode` / `fragmentNode` materials **must** call
  `atmosphere.applyFog(litColor, positionWorld)` on the final lit colour (TSL, vec3 → vec3).
  It is analytic (no textures, ~40 ALU), per channel, camera-height aware, and it brightens
  toward the sun. Distant things converge to the horizon sky colour. Leave `material.fog = true`
  on stock materials; set `fog = false` only if you call `applyFog` yourself.

## Sky radiance for reflections

- `atmosphere.skyRadiance(dir)` (TSL, world dir → vec3): one fetch of a horizon-dense panorama
  (sky + clouds, **no sun disc**, refreshed every 30 frames so reflected clouds drift). Below the
  horizon it returns the horizon colour, darkened. Add your own analytic sun specular or glitter
  with `sunDirNode` + `sunColorNode`. The sun disc isn't in `skyRadiance`, so it isn't doubled.

## Screen-space reflections (opt-in, for water and wet sand)

SSR runs only on pixels that opt in. Opting in means writing the `ssr` MRT channel:

```ts
import { ssrOptIn } from '../post/ssr';
material.mrtNode = ssrOptIn(weightNode, roughnessNode);
```

- `weightNode` (float 0-1): the factor **you multiplied `skyRadiance(R)` by** in your shading
  (typically Fresnel × specular occlusion × wetness). The composite does
  `color += weight * hit * (ssrColor - skyRadiance(R))`, so it *replaces* your sky reflection
  with the screen-space hit wherever one exists, and reflections are never doubled.
- `roughnessNode`: SSR fades out between roughness 0.12 and 0.35.
- `R` is computed from the MRT `normal` channel, which is the material's `normalView`. If you
  perturb normals, set `material.normalNode`. If you only bend them inside `outputNode`, the
  reflection uses the geometric normal.
- Channels a pass doesn't have are ignored, so the opt-in is harmless when SSR is off.
- If your material already sets `mrtNode` for something else, merge: `mine.merge(ssrOptIn(...))`.
- Sky pixels are never hit, so the sun disc can't be reflected by SSR. Your glitter owns that.

## Velocity (TRAA + motion blur)

The scene pass writes per-object velocity (`velocity` MRT). three computes the previous position
from `positionPrevious`, which by default is the **undisplaced** geometry. If your material
displaces vertices in `positionNode` (ocean, terrain clipmap, breakers, swaying palms), assign
the displaced previous-frame position, or at least the current displaced position, in the same
Fn. Otherwise TRAA rejects history and motion blur smears:

```ts
material.positionNode = Fn(() => {
  const p = displaced(positionLocal);
  positionPrevious.assign(p); // or displacedAt(tPrev) for true per-vertex motion
  return p;
})();
```

## Shadows

- Four cascades (splits 7 / 26 / 95 / 420 m). PCSS on the two near ones (penumbra from the real
  0.53° sun, scaled by `atmosphere.shadowSoftness`), rotated-disk PCF on the far two. Both rotate
  per pixel and per frame, and TRAA resolves the noise. Set `castShadow` / `receiveShadow` as usual.
- Don't make the ocean surface cast. Receiving is fine (the pier's shadow on the water).
- Every shadow caster renders four times per frame (~2.3 ms CPU on the M3 for the current
  scene). Keep casters lean. Use `castShadowPositionNode` / simplified geometry where you can.
- Custom lighting that wants the sun shadow term: use a stock lit material path, or ask A1.

## Post chain

`scene pass (MRT: colour, normal, velocity, ssr) → SSR composite → GTAO → TRAA → DOF →
motion blur → bloom → light shafts → grade → AgX+look → sharpen → vignette + grain`.
Every stage is a `post.*` toggle (F1 → post), and toggles rebuild the chain. Off by default:
DOF (softens the near field) and light shafts (B2 decides where they earn their pixels).
Grading params: `post.temperature`, `post.tint`, `post.lookWarmth` (warm highlights),
`post.splitTone` (cool shadows), `post.lookSaturation`, `post.punch`, `post.contrast`,
`post.vignette`, `post.grainAmount`.

## Perf hooks

- `ctx.perf.systemMs.render`: CPU time to encode the frame (three's render + the post chain).
- `ctx.perf.gpuMs.{frame, scene, post, preScene, compute}` from timestamp queries (resolved
  every 30 frames). On Apple GPUs passes overlap, so treat per-pass numbers as indicative only;
  use frame-time deltas from toggles (PERF.md).

## Review shots (lab/shots.ts)

`atmosphere-probes` (calibration spheres, slatted fence for near-shadow crispness, SSR mirror,
6 m pole), `atmosphere-antisun`, `atmosphere-sun`, `atmosphere-sun-disc` (−8 EV, disc ×3, limb
darkening), `atmosphere-pier-shadow`.
