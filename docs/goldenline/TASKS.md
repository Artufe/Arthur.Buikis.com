# GOLDENLINE — agent task list

The brief (`BRIEF.md`) split into ten self-contained agent tasks. The main agent is the
**orchestrator**: it built the base (core, contracts, stubs, site wiring, review tooling), runs the
agents in two phases, integrates between them, and does the final review.

Every agent owns one area, runs **its own review cycle** (§ Review protocol), and reports back
**only when its product is judged good** — or when it is genuinely blocked.

```
Phase A (parallel; 6 at once is this machine's limit)
  A1 atmosphere+post ─────────────────────────────┐
  A2 ocean ──► A7 water shading ──► A8 breaking ──┤
  A3 beach & sand ────────────────────────────────┤
  A4 pier ────────────────────────────────────────┼──► orchestrator: integrate, M2/M3 gates, commit
  A5 surface state ───────────────────────────────┤
  A6 first-person player ─────────────────────────┘
Phase B
  B1 surfing (needs A6, A8) ──► B2 polish + performance + startup ──► orchestrator: final review
```

## User feedback (binding, newest first)

- **After Phase A:** the pier is **shorter**: the orchestrator moved `PIER.tipX` from −176 to −110
  (a 144 m deck; the tip sits in 11.4 m of water just past the +Z end of the break). The pier also
  needs an **open end to jump into the water**, and a way to **climb back out**. Both belong to B1
  (see "Pier exit" there).
- **After Phase A:** the waves must be **bigger**: overhead set faces of 2.5–3.5 m at the peak,
  about 1.5 m between sets (A8 owns this). The small wind chop was travelling seaward (it followed the
  offshore breeze); the user wants it to travel **shoreward** with the swell. The orchestrator
  changed `ocean/index.ts` (`spectrumParams`) so the short cascades follow the swell. Keep it that way.
  The offshore breeze still blows spray off the lips toward the sea.
- **After Phase A:** startup is too slow. See **Startup optimisation** in B2.

---

## Shared ground rules (every agent)

**Read first:** `docs/goldenline/BRIEF.md` (the product), this file (your task + protocol), and
`components/goldenline/core/contracts.ts` (the interfaces you code against).

**Ownership.** You own your directory (listed per task) and may create anything inside it,
plus assets under `public/goldenline/<your-area>/`. Everything else is read-only to you:
- `core/`, `systems.ts`, `world/layout.ts`, `world/terrain-shape.ts`, `ui/`, the React files and
  site files are orchestrator-owned. If you truly need a core change, make the **smallest
  backward-compatible, additive** edit, mark it `// [<area>] <why>`, and list it in your report.
- `lab/shots.ts` is shared and **append-only**: add shots prefixed with your area name.
- Never edit another agent's directory. If you need something from another system, code against
  the contract (a stub stands in until the real one lands), and put the request in your report.

**The tree is shared and live.** One dev server (`http://localhost:3000`, started by the
orchestrator) compiles everyone's code into the same `/surf` route. So:
- Never leave a file syntactically broken or importing a missing module. Make changes in small,
  compiling steps. A TS *type* error won't break the dev server; a syntax/import error breaks
  everyone's screenshots.
- A system that throws at runtime is disabled by the core (with a console error) instead of
  crashing the demo. Watch the console output the shot tool prints.
- If the shot tool fails because of an error in *someone else's* directory, wait a minute and
  retry (up to ~10 minutes). Do not touch their files.
- If `curl -s localhost:3000 >/dev/null` fails for more than a minute, check `lsof -i :3000`; only
  if nothing is listening, restart it from the repo root with
  `(PATH="$PWD/node_modules/.bin:$PATH" nohup node scripts/dev.mjs > <scratch>/goldenline-dev.log 2>&1 &)`.
- **No git writes.** No commit, stash, checkout, reset, rebase or branch. The orchestrator commits.
- **No new npm dependencies** without a very strong reason (list it in your report; the
  orchestrator installs). three 0.186 (`three/webgpu`, `three/tsl`, `three/addons/*`) is available.
- Don't run `pnpm` (local pnpm 11 re-installs). Use `npx tsc --noEmit` and `npx vitest run`.
  **Don't run `npx next build`**: it writes `.next/`, which parallel builds would corrupt. The
  orchestrator builds. Run at most one shot-tool process at a time (the machine has 16 GB and one GPU).

**Code rules (from BRIEF §4).** Zero allocations in `update()`: no `new`, no closures, no
`map/filter/reduce`, no spread or object-creating destructuring, no per-frame strings.
Preallocate scratch (`core/pool.ts` has shared scratch vectors and a `Pool<T>`). Typed arrays for
uploads. Instancing for repeats. `dispose()` frees everything. Every tunable an artist would
reach for is a param (`ctx.params.number/toggle`, group = your area) so it shows in the F1 overlay
and can be overridden per shot (`--p key=value`). Your `warmup()` must make every pipeline you
will ever use compile during loading (brief §5).

**Style.** Match the repo: TypeScript, 2-space indent, single quotes, comments only where they
carry a *why*. Keep modules focused (split a 1,500-line file).

**World conventions** (`world/layout.ts`): metres, Y up, sea level 0, ocean toward −X, beach toward
+X. Facing the sea, **+Z is your left** (the pier side) and −Z your right (the peak). Camera yaw:
forward = (−sin yaw, 0, −cos yaw). Sun fixed at 11° elevation, 9° toward +Z from straight out
to sea. Time: read `ctx.time.t` / `ctx.time.dt`, never the wall clock.

**Budget.** Your system's share of the 11.1 ms target is listed per task (for the RTX 5070 Ti).
On the M3 proxy (1280×720, `high`), the whole frame must stay ≤ 22 ms median; measure your
system's cost in isolation (toggle it via its params) and record it in `PERF.md`. Phase A agents
share one GPU, so numbers are noisy — record them anyway; B2 does the definitive pass.

**Docs.** Append to `docs/goldenline/DECISIONS.md` (one line per deviation, prefixed `[area]`),
`PERF.md` (your measured costs) and `ASSETS.md` (every third-party asset: source URL, licence).
Only CC0 assets. Vendor them in `public/goldenline/<area>/` (1K–2K, WebP/JPG for colour, PNG for
data). Area budgets: atmosphere 2 MB, ocean 2 MB, water 4 MB, beach 12 MB, pier 8 MB,
player 6 MB, surf 2 MB, polish 4 MB.

---

## Review protocol (every agent)

You are both builder and harshest critic. Loop until done:

1. **Build** the next increment.
2. **Capture** at 2560×1440 with `node scripts/goldenline-shot.mjs` (run with no args to read its
   header: `--shot a,b --out dir/`, `--cam x,y,z,yaw,pitch`, `--t`, `--advance`, `--seq N
   --interval s` for motion, `--perf S --size 1280x720`, `--p key=value`). Work shots go in
   `<scratch>/goldenline/<area>/round-<n>/` (the orchestrator gives you `<scratch>`). Always capture the shared beauty shots that show your
   work, plus your own shots (add them to `lab/shots.ts`). Check motion with `--seq`, not only stills.
3. **Look** at every image (Read the PNG). Write the critique down in
   `<scratch>/goldenline/<area>/review.md`: the **five most visible flaws**, ranked, each tied to a
   brief section or acceptance criterion. Be specific ("foam edge aliasing at 2 m", not "foam
   could be better"). Compare against real reference photography of golden-hour reef breaks.
4. **Fix** the top flaws, replace techniques that aren't working (don't patch them), repeat.

**Exit criteria. Report only when all of these hold:**
- At least **four** full review rounds, and in the last round none of the five flaws is
  something a first-time viewer would notice.
- Every acceptance item listed in your task passes, with a screenshot path as evidence.
- `npx tsc --noEmit` passes with no errors in your files. No console errors from your system.
- Zero allocations in your `update()` (verify with a Chrome performance/memory trace or by
  inspection, and say which).
- `warmup()` covers every pipeline. Your measured cost is in `PERF.md`.
- Final evidence shots (JPG, `--jpg`) copied to `docs/goldenline/shots/<area>/`.

If you are **blocked** (a contract gap, a dependency that doesn't exist yet, a platform limit),
don't stop early and don't fake it: work around it with a stub on your side, finish everything
else, and report `status: "blocked"` with exactly what you need.

**Report** (your final message, structured): status, summary, files touched (including any core
edits), contract additions, evidence shots, the acceptance checklist with pass/fail and evidence,
measured perf, known issues, and **handoff notes** for the agents that build on you.

---

## A1 · Atmosphere, lighting & post — `atmosphere/`, `post/`

**Replaces:** the `atmosphere` and `post` stubs. **Brief:** §3.6, §3.7 (and the tonemapping
parts of §0). **Budget:** 0.5 ms atmosphere + 1.9 ms post.

Build:
- A physically based sky (single-scattering Rayleigh + Mie with an ozone term, or a
  precomputed LUT approach à la Hillaire) with exact sun control, **not** an HDRI. Golden-hour
  cirrus/scattered cumulus lit orange/pink from below (layered 2D noise with
  sun-dependent scattering is fine if it holds up). A sun disc with correct limb darkening.
- `AtmosphereService` for real: `sunDir`, `sunColor` (reddened by the actual transmittance),
  `applyFog(color, worldPos)` for aerial perspective and golden marine haze with height falloff
  (contrast compresses with distance and brightens toward the sun), `skyRadiance(dir)` for
  reflections, and an `envTexture` (PMREM of the sky) for IBL. Set `scene.fogNode` /
  `scene.environmentNode` / background so stock node materials get it for free.
- The sun light: cascaded shadow maps (`CSMShadowNode`) with soft filtering, cascades tuned so
  footprint and plank shadows near the camera stay crisp while the pier's long shadow still
  reaches across the water. Ambient: a warm peachy horizon dome against a cooler zenith, so
  shadowed sand goes lavender-blue, not grey.
- The post chain (`RenderPipeline`): TRAA (with the MRT velocity it needs) → GTAO → SSR hook
  (enabled only for water/wet-sand pixels, via a material flag or roughness gate other systems
  can opt into) → restrained DOF → camera + per-object motion blur → bloom → AgX → film grain →
  post-TAA sharpen. **Every stage toggleable** (`post.*` params), rebuilt on toggle via
  `PostService.rebuild`. Fill `ctx.perf.gpuMs` from timestamp queries when available.
- A restrained light-shaft pass (godrays) available for spray/pilings, off by default until B2
  tunes it.
- Exposure calibrated so sun glitter and foam roll off without clipping to flat white.

Acceptance: shadowed sand is blue-lavender (not grey or black); distant headland and horizon show
aerial perspective and golden haze; the sky reads as a real golden hour in the `beach-sun`,
`pier-silhouette` and `aerial` shots; no clipped highlights on the stub water's sun glint;
every post stage toggles without errors; shadows are crisp at 2 m and present at 150 m.

Handoff: document how custom materials opt into SSR, velocity/MRT and fog in
`atmosphere/README.md`. Every other agent reads this.

## A2 · Ocean simulation — `ocean/` (not `ocean/breaking/`), `world/seabed.ts`

**Replaces:** the `ocean` stub. **Brief:** §3.1 (open water, swell and sets, bathymetry).
**Budget:** 1.0 ms (FFT + clipmap).

Build:
- A GPU FFT ocean in TSL compute (Tessendorf; JONSWAP or TMA spectrum with directional
  spreading), with **at least three cascades** (long swell, wind waves, capillary chop) and
  horizontal (choppy) displacement plus a Jacobian/folding output for foam.
- The groundswell as a *separate*, controllable component, a small set of long-period
  directional wave trains (Gerstner/trochoidal or analytic), grouped into **sets of 3–5 with
  lulls** (`SWELL` in `world/layout.ts`). The CPU and GPU evaluate the same analytic swell, so
  `OceanService.sample()` is exact for the part that matters for floating and riding, with the FFT
  detail as a GPU-only addition (optionally with a small, stable CPU approximation).
- Depth-aware swell: shoaling (height gain, wavelength compression and crest steepening from
  the seabed depth) and refraction bending swell lines around the reef. Refine
  `world/seabed.ts` (you own it: reef shelf texture, reef-edge shape, channel, nearshore sand).
  Keep it continuous with `world/land.ts` across the swash zone, and keep the reef edge where
  `REEF` says so the break stays where the composition wants it.
- A camera-centred clipmap / projected-grid surface that holds up at **arm's length while
  paddling** (0.5 m eye height) and out to the horizon without swimming or popping.
- A placeholder water material (the water agent replaces it) that is honest enough to judge
  the waveform: normals, fresnel, a flat absorption colour.
- `OceanService`: `sample()` (height, normal, velocity, depth, breaking), `wave()` (return the
  shoaling crest nearest the point with `stage`/`faceHeight`/`dir`; A8 extends it with breaking
  data), `swellDir`, and `gpu` (the cascades' textures, length scales, the swell uniforms, the
  surface mesh and its displacement node). **Document `gpu` in `ocean/README.md`**: A7 and A8
  build directly on it.

Acceptance: at 0.5 m eye height (`lineup` shot) there is no visible tiling, faceting or
swimming; three scales are legible at once (swell, wind waves, chop); sets arrive with lulls
(`--seq` over 90 s of sim time); swell visibly steepens and bends over the reef; `sample()`
matches the rendered surface within 5 cm (verify by probing).

Handoff: `ocean/README.md` for A7 (water shading) and A8 (breaking waves). A8 builds breakers on
your swell trains: expose per-train phase, amplitude, wavenumber and direction.

## A3 · Beach, sand & far field — `beach/`, `world/land.ts`

**Replaces:** the `beach` stub. **Brief:** §2 (setting), §3.4. **Budget:** 1.1 ms.

Build:
- A camera-centred terrain clipmap / nested-ring LOD over land *and* the visible seabed (the
  water shader refracts it), with sub-10 cm vertex spacing near the player. Height = the baked
  base (`terrain.heightTexture`) + GPU detail: swash-built berms and cusps, wind ripples on the
  dry sand, dune line, and reef texture underwater (coordinate with seabed.ts through the shared
  heightfield; you own land.ts only).
- Sand shading (custom node material): three-scale normals, grain sparkle (sparse, grazing only,
  TAA-stable), **wet vs dry as separate states** driven by `state.sand()` (wet is darker,
  smoother and glossy, with a mirror film right after a swash that opts into SSR), foam-residue
  lines, and footprints read from `state.sand()` depression/mass with self-shadowing (normals
  from the same data). Until A5 lands, fake a wet band from the height above sea level so you
  can tune the look.
- Underwater seabed shading: sand ripples, reef rock and coral texture, ready for A7's
  caustics (expose a hook: `beach` material accepts a caustics node).
- Far field: the volcanic headland at one end, a distant island silhouette, heavy aerial
  perspective (`atmosphere.applyFog`). Impostors or matte-projected meshes are fine if they
  never read flat.
- Dressing: a few palms leaning off the dune line (procedural trunk + frond cards with wind
  sway; instanced), sparse dune grass, shells, coral rubble and a dried seaweed line at the
  high-tide mark (thin instances).

Acceptance: no faceting on sand at any distance; three scales on sand (slope, ripples, grain);
the wet/dry transition reads as real in `beach-sun` and `wetsand-reflection`; footprints (test by
calling `state.splat(SPLAT_FOOTPRINT, …)` from a debug param) have rims and self-shadow in the low
sun; the headland shows aerial perspective; palms don't look like cards.

Handoff: how the sand material reads `state.sand()`, and the caustics hook for A7.

## A4 · Pier — `pier/`

**Replaces:** the `pier` stub and `PierService` stub. **Brief:** §3.5. **Budget:** 0.6 ms.

Build:
- A slender tropical timber pier along `PIER` in `world/layout.ts`: weathered planks with real
  gaps, stringers, cross-bracing, rope-wrapped railings, pilings with a wet-dark tide band,
  barnacles and green algae in the splash zone, dry cracked timber above, a few unlit lanterns.
  Steps or a ramp from the sand up to the deck at the root. All repeated parts instanced.
- Wood shading: anisotropic grain response, sun-bleach variation, spray darkening. Light through
  the plank gaps must paint stripes on the water and sand below (the shadow maps do this if the
  geometry is real; verify). Caustic light dancing on the deck underside (a projected animated
  caustic texture driven by the water below, if A7 hasn't landed yet).
- `PierService` for real: `surfaceAt` (deck + steps), `clampToDeck` (railings), `pilings`.
- Wave interaction: every frame, splat foam and wake into the surface state around each piling
  in proportion to local water speed and `ocean.sample().breaking` (the pilings shed a trailing
  foam wake), and emit pooled spray bursts where whitewater hits a post. Spray visuals should
  share A8's particle look later; build a pooled, compute-driven emitter now.

Acceptance: `pier-silhouette` reads as a real timber pier against the sun; `pier-under` shows
plank-gap stripes and deck-underside caustics; `pier-deck` holds up at 1.7 m (planks, gaps,
nails, railing rope) with no tiling; foam trails behind the pilings (once A5 exists); walking the
deck and steps works through `PierService`.

## A5 · Surface state & interaction — `state/`

**Replaces:** the `state` stub. **Brief:** §3.3. **Budget:** 0.4 ms.

Build:
- Player-following, toroidally scrolled render targets (texel-snapped, no swimming), about 100 m
  wide, plus a coarser, wider foam field for the whole break and shore (the lineup is ~150 m
  from the beach). Water channels: foam coverage + age, wake height/velocity. Sand channels:
  wetness, depression, displaced mass, freshly smoothed.
- `splat()` is zero-alloc: fixed-size typed-array queue → storage buffer → one compute
  dispatch per frame that stamps all brushes (per-kind brush shapes: soft foam blob, directional
  wake V, footprint heel/toe with a displaced rim, wet disc, smoothing).
- Per-frame simulation passes: foam advection by the ocean's surface velocity (read
  `ocean.gpu` when it exists; fall back to the analytic swell and a longshore current), foam
  ageing/decay into lacy streaks (use a noise-modulated decay so it thins into lace instead of
  fading uniformly), wake propagation and damping, sand drying above the swash, slow footprint
  refill, and swash smoothing.
- The TSL accessors `foam()`, `wake()`, `sand()` with correct world→texture mapping and edge
  fade. A debug param that renders the channels over the scene.

Acceptance: a debug scene (add a shot) shows a footprint trail that holds for more than 60 s on
dry sand and is erased by a smoothing splat; foam splatted in the water drifts, thins into lace
and dissolves over about 30–60 s; no swimming when the camera moves (`--seq` while walking);
zero allocations per frame with 500 splats queued.

Handoff: the brush semantics and strength units in `state/README.md` (writers: player, pier,
breaking waves, surf).

## A6 · First-person player — `player/`

**Replaces:** the `player` stub (walker). **Brief:** §3.8, §3.9 (walk, wade, paddle, catch,
pop-up; *riding is B1's*). **Budget:** 0.6 ms.

Build:
- The player state machine with eased transitions: walk (sand and pier via `PierService`),
  wade (water rising around the legs, swash tugging the camera), paddle (eye line just above the
  water on a spring; the camera never clips the surface; pushing up over whitewater, no
  duck-dive), catch (position + paddle timing with a generous window; feel the wave lift) and
  pop-up (one key, quick physical transition). Riding is a stub mode that B1 fills: expose
  clean hooks (`player/README.md`).
- Carrying the board under one arm on the sand, sliding it into the water when wading.
- The board: a procedural shortboard/fish (lofted from outline, rocker and foil curves — no
  faceting), waxed deck with wax-bump texture, stringer, rails, traction pad, a wet film and
  beading water. First-person arms and hands: paddling strokes (reach, catch, pull), water
  sheeting off the forearms and dripping from fingertips, sun-warmed skin with subsurface
  scattering. **If the arms and hands can't reach a high standard, cut them** (brief §3.8), note
  it in DECISIONS.md, and make the board plus camera motion carry it.
- Bare feet visible when looking down on the sand, with footprints splatted **frame-accurately**
  on each footfall (`SPLAT_FOOTPRINT` + wet where appropriate).
- Camera feel: spring-damped head motion, restrained head bob, FOV and shake hooks that B1
  uses; honours `ctx.reducedMotion` and `ctx.debug.cameraLocked`.

Acceptance: walk from spawn onto the pier and back, down to the water, wade and paddle out,
without a single snap (`--seq` evidence); the paddling eye line in `lineup` shows the board nose
and hands (or a justified cut) looking finished; footprints land exactly under the feet; the
camera never dips below the water surface.

Handoff: `player/README.md`: the state machine, how B1 takes over in `catch → popup → ride`,
the camera hooks.

## A7 · Water shading — `water/` (starts when A2 reports)

**Brief:** §3.2 — the most important code in the project. **Budget:** 1.6 ms.

Build the water material for A2's surface (and, later, A8's breaking-wave meshes, so keep it a
reusable node graph with a thickness input): subsurface scattering in thin crests driven by
thickness, view and sun (**the backlit gold-green lip is the money shot**); Beer–Lambert
absorption and scattering per channel along the refracted path, so the turquoise → teal/ochre
over reef → sapphire gradient emerges from the bathymetry; refraction of the seabed with
restrained dispersion; Fresnel reflections of sky, sun and pier (SSR opt-in, plus
`atmosphere.skyRadiance` fallback); animated caustics projected onto the seabed and pier
underside from the real surface normals (feed A3's and A4's caustics hooks); a sun-glitter path
from a stable high-frequency normal distribution (no crawling under TAA; roll off without
clipping); multi-layer foam (fresh bubbly, ageing lace, sub-surface bubble tint) from
`state.foam()` and the ocean's Jacobian; flow-advected capillary micro-normals and wind slicks.

Acceptance: `lineup` shows water that holds up at arm's length; `beach-sun` shows the depth
gradient and legible seabed with caustics in the shallows; the sun-glitter path neither clips nor
shimmers (`--seq`); thin crests glow when backlit (craft a shot with a steep swell crest against
the sun until A8's breakers exist); foam reads as foam, not white paint.

Handoff: `water/README.md`: how A8 applies the material to breaking-wave geometry and whitewater.

## A8 · Breaking waves, whitewater & swash — `ocean/breaking/`, `vfx/spray/` (starts when A7 reports)

**Brief:** §3.1 (breaking waves, whitewater, shore break and swash). **Budget:** 1.8 ms.

Build, on A2's swell trains and A7's material:
- **Real breaking-wave geometry**: a parametric breaker profile swept along the break line and
  blended seamlessly into the ocean surface. It evolves through steepening face → pitching lip
  → lip thrown forward → curl → collapse → whitewater bore, triggered by *depth* (shoaling
  criterion), peeling along the reef toward +Z at a speed consistent with the swell angle.
  **Overhead waves (user direction): set faces of 2.5–3.5 m at the peak, about 1.5 m between
  sets.** The ocean agent's first cut peaked around a 1.6 m face, which the user found too small.
  Raise the swell yourself (A2 has finished, so `ocean/swell.ts`, `ocean.swellHeight` and the
  breaking criterion are yours to retune) and re-check the break point, peel speed and the
  channel beside the pier, which must stay unbroken. Throwing sections form a makeable
  tube (a real open curl the camera can sit inside).
- Whitewater: lip impact → aerated explosion (volumetric-looking foam geometry/billboards +
  compute spray + mist) → shoreward bore → spreading foam sheet written into `state` as foam.
  The pooled compute spray system in `vfx/spray/` is shared with B1 (rail spray) and A4 (piling
  bursts): design its API for them.
- Offshore spray veils peeling off the lips, streaming seaward, backlit gold.
- The inside: reformed waves reaching the beach as a small dumping shore break, then **swash**:
  a thin, fast run-up sheet that stalls and drains back as backwash, leaving a bubble line, lacy
  foam and a glossy wet film (write `SPLAT_WET`, `SPLAT_FOAM` and `SPLAT_SMOOTH` along the run-up
  front). It must never look like a plane sliding up and down.
- Extend `OceanService.wave()` with the live breaker data (stage, peel direction/speed, crest
  distance, face height, hollowness), and make `sample()` include the breaker, so B1 can ride
  it. Whitewater that reaches the pilings interacts with them (A4's hook).

Acceptance (the M3 gate): watched from the sand for a full set (`shorebreak`, `beach-sun`, and a
new `breaking-peel` shot, as `--seq` over 60 s), lips pitch, the whitewater has mass, the
peel runs toward the pier, the swash sheets and drains like water; the tube interior (add a
`breaking-tube` shot) reads as a glowing, translucent ceiling of water; the whitewater has
visible mass and momentum, not just particle spray.

Handoff: `ocean/breaking/README.md` for B1: how to query and ride the wave, and the spray API.

---

## B1 · Surfing — `surf/`

**Brief:** §3.9 (ride, wipeout), §3.10 (the centrepiece). **Budget:** 0.8 ms (+ shared VFX).

Take over the player at `popup` → `ride` → `wipeout`/exit using A6's hooks and A8's
`wave()`/`sample()`: board physics on the moving face (planing speed from the face slope and
water velocity, rail engagement, trim, pump, stall, bottom and top turns, cutbacks), the
controls (mouse look chooses the line, A/D rail-to-rail, W pump/trim, S stall; refine as needed),
camera banking with carves, FOV with speed, subtle shake on the drop, hard turns and whitewater
hits (reduced motion respected). Rail wake written into `state` (a foam line that persists on
the face and in the soup), backlit tail-spray fans off hard turns via the shared spray system
(they must cast shadows), and the **tube**: stall into the curl on hollow sections and hold it,
with transmitted light through the ceiling and droplets hanging in the air. Wipeouts: a short
violent tumble of camera and spray that stays above the surface, then an eased recovery to
paddling. Speed without audio: motion blur on the face, spray streaking past, foam lines rushing
under the board, horizon bank, and nose chatter over chop. Tune by hand until it is fun.

**Pier exit (user request, added after Phase A).** Getting from the pier into the lineup and
back is part of the loop. You may edit `pier/plan.ts`, `pier/service.ts` (and extend
`PierService` additively) and the player controller for this; list every change.
- **Open end:** a ~1.4 m gap in the tip railing, finished like the rest of the pier (end posts,
  whipped rope ends tied off, worn planks where people stand), plus a timber **swim ladder** from
  the gap down into the water (barnacles and algae below the tide line, like the pilings).
  `clampToDeck` lets the body through the gap and nowhere else.
- **Jump:** at the open edge, Space (or walking off) launches a physical jump with the board
  under the arm: a short run-up, the drop from the 4.2 m deck, a big entry splash (shared spray
  system + foam, wake ring and disturbance splats), then an eased hand-off into `paddle` as the
  board comes under the chest. The camera must still never go below the surface (brief: no
  underwater). Stop it at the surface inside the splash (a whiteout of spray and water sheeting
  is fine), never a cut.
- **Climb:** paddle up to the ladder and press Space (or W into it) to climb. Hands on the rungs
  (first-person), the board tucked under one arm or slid onto the deck first, eased steps, water
  streaming off, then step onto the deck in `walk`. Nice to have: climbing back out onto the
  stairs' landing at the root the same way.
- **Stretch (only if it looks finished):** vault over the railing anywhere along the deck by
  facing it and pressing Space, and drop into the water. The user named this as the fallback if an
  opening wasn't possible; with the opening it's a bonus, so cut it rather than ship it rough.

Acceptance: a scripted ride (write a deterministic input playback for the shot tool) from
takeoff through two carves into a tube section and out beside the pier; its `--seq` frames show
the drop, the backlit face, a spray fan casting a shadow, the foam trail persisting after the
wave has passed, and the tube ceiling; no snaps entering or leaving any state. Plus a scripted pier run: walk out the deck,
jump through the opening, paddle, climb the ladder back up (`--seq` evidence, no snaps, the camera
never underwater).

## B2 · Polish, performance & startup — `vfx/` (except `vfx/spray/`), plus tuning passes

**Brief:** §3.6 (spray veils, salt mist, light shafts), §2 (ambient life), §3.7 calibration, §4,
§5, §9. **Budget:** 0.3 ms for the ambient VFX; you own the frame total (10.6 ms allocated, 0.5 ms headroom).

Ambient life and atmosphere: seabirds gliding along the break, ghost crabs darting on the wet
sand, palm frond motion checked, salt-mist volume over the impact zone, light shafts only where
they earn it. Then **the polish pass over the integrated scene**: tonemapping calibration,
colour cohesion across systems, highlight roll-off, and a check that every shot in
`lab/shots.ts` is beautiful. You may tune params of any system (defaults in their param
registrations) and make small fixes in other directories *only* where they are clearly
integration bugs. List every one in your report.

Then **performance hardening**: profile (Chrome trace + `--perf`), remove every allocation in
every `update()`, verify the warm-up covers every pipeline (instrument pipeline creation after
the loading screen: it must be zero across a full playthrough — walk, pier, paddle, ride, tube,
wipeout), verify the M3 proxy budget, set the quality presets, and fill `PERF.md` with the
per-system table. Finally, walk the **BRIEF §9 acceptance list** item by item with evidence
shots in `docs/goldenline/shots/final/`.

**Startup optimisation** (user request, added after Phase A). Startup is slow today. Baseline, from
`node scripts/goldenline-shot.mjs --boot` (dev server, M3, other agents sharing the GPU):

| stage | ms | what is really happening |
|---|---|---|
| dev route compile (before boot) | ~19,000 | Turbopack compiling `/surf` on first visit. Dev only, but measure the prod chunk size |
| init (all systems) | ~3,500 | CPU bakes on the main thread: beach 1.1 s, player limb meshing 0.9 s, water 0.5 s, ocean 0.35 s (+ ~1 s swell eikonal) |
| warmup beach | ~16,000 | the **first full post-chain render**: every system's pipelines node-built and compiled synchronously, one by one (main MRT pass + 4 shadow cascades) |
| warmup pier | ~3,000 | the same again for pipelines the first frame missed |
| compileAsync | ~2,200 | |
| **engine total** | **~25,000** | plus the dev compile ≈ 44 s from click to "click to paddle out" |

Targets: on a **production build** (`npx next build && npx serve out`, M3, warm HTTP cache), under 5 s
from opening the window to "click to paddle out"; under 8 s with a cold cache; the loading
bar keeps moving (no main-thread task over ~200 ms without yielding); and still **zero pipeline
compiles after the loading screen closes** (the hitch rule wins over load time). Directions to
try, measured one by one:
- Compile pipelines **in parallel and asynchronously**: `compileAsync` against the real post-chain
  scene pass (its MRT target) and each shadow cascade, not a synchronous first frame; kick off all
  systems' compiles together.
- Cut the pipeline count: share materials and node graphs across meshes, and merge permutations
  that differ only by a uniform; log the count per system before and after.
- Move CPU bakes off the main thread (workers) or onto the GPU (compute), or precompute them at build
  time into compact binary files in `public/goldenline/` (terrain heightfield, swell eikonal field,
  sky LUTs, limb meshes, pier plan) when that is smaller and faster than recomputing.
- Run independent `init()`s concurrently instead of strictly in sequence where their contracts
  allow it (the core loop in `core/engine.ts` may change for this; coordinate with the orchestrator).
- Start loading before the click: prefetch the engine chunk and assets when the palette opens or on idle.
- Loading screen: show real per-stage progress (the boot timeline is in `ctx.perf.boot`).

Record the before and after timelines in `PERF.md`.

Acceptance: all of BRIEF §9, except the 5070 Ti numbers, which are recorded later on the target PC,
plus the startup targets above.
