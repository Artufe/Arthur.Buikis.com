# beach/ — terrain, sand, seabed, far field, dressing (A3)

Owner: A3. Everything is procedural; no third-party assets (nothing in `public/goldenline/beach/`).

## What's here

| file | what |
|---|---|
| `index.ts` | the `beach` system: bakes, builds meshes, per-frame LOD selection, params |
| `cdlod.ts` | camera-centred CDLOD terrain: CPU quadtree selection → one instanced draw of 16×16-quad patches; 3.1 cm vertices near the camera, 12 levels to 2 km, crack-free morphing |
| `height.ts`, `ground.ts` | TSL height: cubic B-spline (C2, 4 taps) of height+gradient bakes of the base terrain (1 m near, 8 m far), plus GPU detail. `ground.height(xz)` is what props sit on |
| `chunks.ts` | spatially chunked InstancedMeshes with draw distances (props, plants) |
| `vegetation.ts` | dune grass clumps and creeper mats (runners with stalked, cupped leaves) where the baked cover says so, within ~40 m |
| `sand.ts` | the terrain material (MeshPhysicalNodeMaterial): dry / damp / saturated / film sand, dune vegetation, seabed ripples, reef rock and coral heads |
| `bake.ts` | boot-time CPU bakes: tileable slope-encoded detail tiles (wind ripples, seabed vortex ripples, swash marks, grain, macro), far heightfield, reef mask |
| `far.ts` | the volcanic headland (–Z end of the bay) and the distant island: real meshes from analytic ridged heightfields |
| `palms.ts` | 12 coconut palms (3 instanced variants): curved ringed trunks, V-folded leaflet fronds, coconuts, wind sway, backlit transmission |
| `dressing.ts` | the wrack line of dried sargassum, shells and coral rubble at the high-tide mark (re-seated on the rendered ground on the GPU) |
| `rng.ts`, `tsl-noise.ts` | deterministic PRNG; TSL Voronoi and hashes |
| `debug-sand.ts` | a CPU footprint field that stands in for `state.sand()` only while the state system is a stub |
| `hooks.ts` | the caustics hook for the water system |

## How the sand reads `state.sand()`

`sand.ts` takes a `SandSource` built in `index.ts`: `state.sand(xz)` for wetness / smoothing and
`state.sandHeight(xz)` (mass − depression) for relief, at `state.sandTexel` (2.5 cm).

- **Relief (footprints):** the vertex stage adds the relief, box-filtered over one state texel
  (4 taps; the box-filtered bilinear field is C1, so walls are rounded, not texel-creased). The
  fragment normal is the gradient of the same filtered field, so geometry and shading agree.
  Self-shadowing: a 10-step march of `sandHeight` toward the sun (1.7 cm steps) multiplies the
  sun's shadow term through `material.receivedShadowNode`, within 16 m of the camera
  (`beach.contactShadow`).
- **Wetness:** state semantics (`state/README.md`): 0 dry · 0.5 damp · 0.88 saturated · > 0.95 film.
  All gloss comes from the state: the swash wets the sand exactly where its sheet runs, and the
  state dries it (film, then sheen, faster high on the beach face), so the shine follows each
  run-up and retreats toward the water. The material only adds a matte damp band (0.3) up to the
  high-tide mark `beach.highTide` (1.45 m). With the state stub (`beach.fakeWet`) painted bands
  stand in: the fake swash band, a saturated strip below `beach.saturatedTop` and a film up to
  `beach.filmTop` that drains in patches. The film's normal is levelled toward +Y (a water film is
  flatter than the sand under it), so it mirrors the sky, sun and pier instead of the sea.
- Damp sand darkens (×0.45, more saturated) and loses its ripples; saturated sand darkens
  further (`beach.wetDarken`) and turns glossy (roughness 0.42); the film is a near mirror
  (roughness 0.045). Dry grains get `specularIntensity` 0.18 (sand back-scatters; GGX's grazing
  forward lobe would wash it out), water restores it to 1.
- **SSR:** `material.mrtNode = ssrOptIn(fresnel × max(film, 0.5 × saturated), roughness)`.
- Foam residue: a lacy Voronoi-wall network at the drying edge of the swash (wetness 0.62–0.93).

## Caustics hook (A7)

```ts
import { setCausticsHook } from '../beach/hooks';
setCausticsHook((worldPos, normal, albedo) => causticRadiance); // vec3, linear
```

Call it in the water system's `init()` (it runs before the beach) — the beach reads the hook when
it builds its material and adds `hook(...) × underwaterMask` to the emissive. Setting it later
rebuilds the material automatically (then make sure it happens before warm-up). Return radiance
*reaching the seabed* (include the sun colour, attenuation to depth and the sun shadow if you have
it); the beach doesn't multiply by anything but its underwater mask.

## Seabed

The same terrain mesh continues under water. Below −0.3 m the surface switches to wet seabed sand
with wave-formed vortex ripples (λ ≈ 57 cm, crests parallel to the swell, displaced within 46 m of
the camera). On the reef (mask baked in `bake.ts`, mirroring the meandering edge and presence in
`world/seabed.ts` — keep them in sync if the reef moves), massive coral colonies (domain-warped
Voronoi cells, 0.15–0.45 m domes with knobbly surfaces and a per-colony palette), a turf-brown
rubble pavement and sand pockets are displaced and shaded per pixel, on top of seabed.ts's own
metre-scale bommies. `beach.debugView = 2` shows the
reef mask/heads/pockets. Absorption, refraction and caustics are the water's job.

## Land shape (`world/land.ts`)

Face 1:9 through 0 m at the mean water line (d = 0), beach cusps (~24 m) in the upper swash zone,
berm crest ~2.3 m at d ≈ 20, a backshore dipping slightly landward, a hummocky foredune (toe
d ≈ 54, crest 6–9 m) with blowouts, a swale and low vegetated hills. The seabed runs 1.2 m lower at
d = 0; `terrain-shape.ts` blends the two over ±12 m (a steeper foreshore), putting the actual
waterline at d ≈ 2.5.

## Params (group `beach`)

Look: `sparkle`, `ripples`, `wetDarken`, `albedo`, `highTide`, `reefRelief`, `contactShadow`,
`vegetation`, and `fakeWet` + `swashTop`, `saturatedTop`, `filmTop` (these four only with the state stub).
Perf / A-B toggles: `terrain`, `terrainShadow` (off), `lodRange`, `farField`, `palms`, `props`,
`plants`. Debug: `debugPrints` (stamps N footprints ahead of the camera via `state.splat`),
`debugView` (1 wetness bands, 2 reef).

## Shots (lab/shots.ts)

`beach-dry`, `beach-feet`, `beach-wetfeet`, `beach-wetsand`, `beach-seabed`, `beach-headland`,
`beach-dune`, `beach-wrack`, `beach-palms`. Evidence JPGs: `docs/goldenline/shots/beach/`.

## Props that sit on the sand

Use `ground.height(xz)` (TSL) for exact seating on the rendered surface, or
`terrain.height(x, z)` on the CPU (within ~1 cm; ripples and footprints excluded).
