# Snake 3D — design

Date: 2026-09-25 · Branch: `feat/snake-3d`

## Goal

Rewrite the site's snake easter egg as a visually impressive 3D game set on desert sand. The snake carves a groove into the sand that lingers, then narrows and fades until the sand is smooth again. The old coding theme (code-token pellets, REPL console, `panic!` copy) is dropped.

Success means: it looks striking in a screenshot at desktop, mobile, and floating-window sizes; it plays smoothly (target 60 fps on a mid-range laptop, playable on a modern phone); and an independent visual critic, reviewing screenshots only, reports no major issues after at most three iteration rounds.

## Decisions (agreed)

| Question | Decision |
|---|---|
| Rendering | Plain three.js, imperative. `three` replaces `pixi.js` (pixi is used only by snake). Post-processing from `three/addons`. |
| Trail | Visual only — a groove in the sand, not an obstacle. |
| Movement | Free steering, not grid-based. |
| Camera | High 3/4 view that follows the head with soft lag. Camera never rotates (fixed yaw), so controls are screen-relative. |
| Surfaces | Keep the floating window (command palette → "play snake") and the `/snake` page. |
| Sound | Procedural Web Audio (no audio files), muted by default, toggle persisted. |
| Leaderboard | Local top 10 in `localStorage` with 3-letter initials. No backend. |
| Mouse steering | Yes, alongside keys and touch. |
| Light/dark | Scene follows the site theme: light = golden-hour dunes, dark = moonlit night desert. |

## Architecture

Three layers, same shape as today:

1. **Engine** — pure TypeScript, no DOM or three.js imports. `createInitialState`, `applyInput`, `step(state, dt)`. Seeded PRNG (Mulberry32) so tests can replay runs.
2. **Host** — `SnakeCanvas` React component. Owns the fixed-timestep loop (accumulator, 60 Hz simulation), input mapping, best-score storage, HUD overlays. Compares state before/after each step to fire renderer events.
3. **Renderer** — `mount(canvas, opts) → RendererHandle`, dynamically imported so three.js loads only when the game opens. The engine never calls the renderer.

### Files

```
components/snake/
  engine/types.ts          # state, input, constants
  engine/engine.ts         # createInitialState / applyInput / step
  engine/path.ts           # path history + arc-length sampling helpers
  engine/rng.ts            # Mulberry32
  engine/engine.spec.ts    # unit tests
  render/mount.ts          # RendererHandle; owns scene, loop hooks, dispose
  render/terrain.ts        # dune heightfield + sand material (shader)
  render/trail-map.ts      # offscreen trail render target
  render/snake-mesh.ts     # tube body + head
  render/food.ts           # food meshes + pickup burst
  render/particles.ts      # sand spray, wind wisps, dust
  render/environment.ts    # sky, sun, fog, rocks ring, lights
  render/post.ts           # composer: bloom, output/tone mapping
  render/camera-rig.ts     # follow camera
  render/palettes.ts       # light (golden hour) / dark (moonlit) scene palettes
  audio/sound.ts           # Web Audio synth: ambience + one-shot effects
  leaderboard.ts           # local top-10 storage (pure, unit-tested)
  leaderboard.spec.ts
  snake-canvas.tsx         # host (rewritten)
  snake-window.tsx         # kept (drag/Escape/expand)
  snake-window-host.tsx    # kept, console panel removed
app/snake/page.tsx          # kept, console panel removed
lib/snake-bus.ts            # unchanged
```

Deleted: `snake-engine.ts`, `snake-engine.spec.ts`, `snake-renderer.ts`, `snake-shader-crt.ts`, `snake-console.tsx`, `snake-types.ts`. Dependency `pixi.js` removed, `three` + `@types/three` added; `pnpm-lock.yaml` updated (CI uses `--frozen-lockfile`).

## Engine

World units: arena is a circle of radius `ARENA_R = 20` centred at the origin on the XZ plane.

State:

- `head: {x, z}`, `heading` (radians), `targetHeading | null`, `speed` (units/s).
- `path`: ring of recent head positions sampled every `SAMPLE_SPACING = 0.15` units of travel (newest first), trimmed to `bodyLength + margin`.
- `bodyLength` (arc length, starts at 4, `+GROW_PER_FOOD = 1.2` per food).
- `food: Food[]` — `{ id, pos, kind: 'normal' | 'golden', spawnedAt, expiresAt | null }`.
- `status: 'idle' | 'playing' | 'paused' | 'gameover'` (starts `idle`; the first steering input starts play), `score`, `best`, `time` (sim seconds), `rngSeed`, `deathCause: 'wall' | 'self' | null`.

Rules:

- **Steering**: input sets `targetHeading` (8-way from keys, analog from touch drag). Each step the heading rotates toward the target by at most `TURN_RATE = 3.6 rad/s × dt`, shortest way round. A reversal (target exactly opposite) turns in the current rotation sense rather than stalling.
- **Speed**: `BASE_SPEED = 5` units/s, `× 1.04^score`, capped at `MAX_SPEED = 11`.
- **Walls**: death when `|head| > ARENA_R − HEAD_R`.
- **Self-collision**: death when the head is within `2 × BODY_R` of any path sample whose arc distance from the head exceeds `SELF_SAFE_ARC = 1.2` (skips the neck).
- **Food**: one normal food always present. Eating (head within `EAT_R = 0.9`) adds +1, grows the body, respawns. On each eat, 12% chance to also spawn a golden food (+3) that expires after 6 s. Spawn positions are rejected if within 2 units of the body or outside `ARENA_R − 2`.
- **Pause / restart**: space toggles pause; `r` restarts, keeping `best`. Engine time only advances while playing; the host passes `dt`, never wall-clock timestamps, so pause/restart cannot desync timers (fixes a class of bug in the old game).

The renderer receives the engine state plus an interpolation alpha between the last two steps.

## Renderer

### Environment

- Sky: gradient dome (deep blue-violet zenith → warm peach horizon) with a sun disc and glow placed low (golden hour, ~12° elevation). Exponential fog tinted to the horizon so distant dunes dissolve into haze.
- Lights: one directional "sun" with shadows (shadow camera fitted to the arena, 2048 map on desktop, 1024 on mobile), hemisphere fill (sky/sand bounce).
- Arena edge: a ring of weathered sandstone rocks (low-poly, displaced icosahedrons, varied scale/rotation, instanced) just outside `ARENA_R`, so the boundary reads clearly without a wall.
- Beyond the rocks, the dune field rises into larger dunes toward the horizon.

### Terrain and sand material

- A large plane (≈ 160 × 160 units), denser in the middle, displaced in the vertex shader by fbm-noise dunes. The height is flattened smoothly inside the arena to a gentle undulation, so gameplay stays readable.
- Fragment shader: base sand albedo with large-scale colour variation; directional wind ripples (anisotropic noise perturbing the normal); fine grain noise; sparse view-dependent glints; slope darkening. Works with three's lighting (built on `MeshStandardMaterial` via `onBeforeCompile`) so shadows and fog apply.

### Trail (the centrepiece)

- An orthographic camera looks straight down at the arena and renders the **trail geometry** into an offscreen float render target (`trail map`, 1024², covering the arena plus margin).
- The trail geometry is a ribbon built from the head's recent path, with per-vertex **birth time**. It is kept for `TRAIL_LIFE = 10 s` of engine time.
- In the ribbon's vertex shader the half-width is `W × shape(age)`: it holds at full width for `TRAIL_HOLD = 4 s`, then narrows smoothly to zero by `TRAIL_LIFE`. The fragment writes groove depth (and a rim profile across the ribbon) into the target.
- The sand shader samples the trail map to (a) lower the height along the groove with raised rims either side (sand pushed aside), (b) perturb the normal from the map's gradient so the groove catches light and casts soft self-shading, and (c) darken/compact the colour inside the groove.
- Result: lingers, then shrinks, then the sand is smooth again. The mechanism is part of the sand, not a decal on top.

### Snake

- Body: a tube mesh rebuilt each frame from the path samples covering `bodyLength` (Catmull-Rom smoothed), radius tapering toward the tail, lifted so it sits in its own groove. Small lateral sway phase travels along the body.
- Material: `MeshStandardMaterial` with a procedural scale pattern (banding plus scale cells), darker dorsal stripe, lighter belly, slight sheen.
- Head: slightly wider, flattened ellipsoid with two glossy eyes; orientation from the heading.
- Casts and receives shadows.

### Food and effects

- Normal food: a glowing desert fruit (warm orange/red, emissive core) bobbing and slowly rotating above a soft contact shadow. Golden food: gold, brighter glow, a subtle ring, and it visibly blinks for its last 1.5 s.
- Eat: sand burst particles plus a brief light pulse at the food's position.
- Movement: small sand spray kicked up at the head, proportional to speed.
- Ambient: wind-blown sand wisps drifting across the dunes.
- Death: the snake sinks into the sand over ~0.8 s with a dust cloud, then the game-over overlay.
- Particles use one `Points` system with a soft round sprite, pooled (no per-frame allocation).

### Post-processing

`EffectComposer` → `RenderPass` → `UnrealBloomPass` (low strength, high threshold: only the sun, food glow and glints bloom) → `OutputPass` (ACES Filmic tone mapping, sRGB). A light vignette. Bloom is disabled on low-quality tier.

### Camera

Perspective camera at roughly 55° pitch, positioned behind (+z) and above the head in world space, looking slightly ahead of it in its travel direction. Follows position with critically-damped smoothing; never rotates in yaw. Clamped so the view never shows far past the arena on the near side. On small aspect ratios (mobile portrait) the camera pulls back a little to keep enough field visible.

### Quality tiers

`high` (desktop): DPR ≤ 2, 2048 shadows, bloom, full particles. `low` (touch devices or when the measured frame time stays over 22 ms for 2 s): DPR ≤ 1.5, 1024 shadows, no bloom, half the particles, trail map at 512².

### Reduced motion

No camera lag (snaps), no screen shake, no ambient wisps or sand spray, food does not bob. The game itself still runs.

## Host and UI

- Controls: arrows / WASD (8-way combos) set the target heading; space pauses; `r` restarts; touch drag on the canvas sets heading from the drag vector; **mouse steering**: while the pointer is over the canvas and has moved in the last 1.5 s, the target heading points from the head toward the pointer's ray hit on the ground plane (y = 0). Any key press hands control back to the keyboard until the mouse moves again. Clicking the canvas starts from idle. Keys are ignored while typing into inputs (as now). Escape closes the floating window (as now).
- HUD overlay (DOM, not WebGL): score top-left, best top-right, "paused" and game-over panels. Game-over shows score, length, best, and "press r to restart" / "tap to restart". Styling uses the site's mono font and warm tokens but must stay legible over bright sand (text shadow or backing plate).
- Best score persists in `localStorage` (`snake.best`, kept for continuity).
- The canvas fills its container: 560 × 640 floating window (the canvas takes the full body; the console panel is removed), full viewport area on `/snake`. It resizes with the container.
- The idle/start state shows the scene with a "press any arrow to start" prompt, so the first screenshot is the attractive scene, not an instant action.

## Light / dark

The scene follows the site theme (`next-themes`, `class="dark"` on `<html>`), read at mount and live-updated via a `MutationObserver` on the class attribute. `render/palettes.ts` defines both as data (sky colours, sun/moon colour, elevation and intensity, hemisphere colours, fog colour/density, sand albedo tint, groove tint, food emissive, bloom strength); `RendererHandle.setPalette()` swaps them with a 0.6 s crossfade (instant with reduced motion).

- **Light — golden hour**: warm peach horizon, low sun (~12°), long warm shadows, amber sand.
- **Dark — moonlit night**: deep indigo sky with a star field (points on the sky dome) and a pale moon, cool blue-silver key light with soft shadows, sand desaturated toward cool grey-beige. The grooves read by moonlight edge highlights; food glows more strongly and bloom is slightly higher so the fruit is the brightest thing in the scene.
- HUD tokens use the site's `--accent` in both modes.

## Sound

`audio/sound.ts` builds everything with Web Audio, no asset files:

- Ambience: filtered noise wind with slow gain/filter-cutoff drift.
- Slither: band-passed noise whose gain follows snake speed (quiet hiss).
- Eat: short two-oscillator pluck with a pitch that rises slightly with the combo (consecutive eats within 4 s). Golden: brighter arpeggio.
- Death: low thump plus a noise burst.
- **Muted by default.** A speaker toggle in the HUD (and the `m` key) unmutes; the choice persists in `localStorage` (`snake.sound`). The `AudioContext` is created on the first user gesture (browsers require it) and suspended when the game is paused, the window closes, or the tab is hidden. Master gain ramps to avoid clicks.

## Leaderboard

`leaderboard.ts` is a pure module over a storage interface (so it is unit-tested without the DOM): `load()`, `qualifies(score)`, `insert({ initials, score, length, date })`, keeping the top 10 sorted by score (ties: earlier date first). Stored under `snake.leaderboard` as versioned JSON; corrupt or unknown data resets to empty. `snake.best` stays in sync (it is the top entry's score).

- On game over, if the score qualifies, the game-over panel asks for 3 initials (A–Z, keyboard or on-screen letter pickers on touch; defaults to the last-used initials) before showing the table. Keyboard shortcuts for steering/restart are suspended while entering initials.
- The game-over panel shows the top 10 with the new entry highlighted; the idle screen shows the top 3.

## Dev test hook

In development builds only (`process.env.NODE_ENV !== 'production'`), `window.__snake` exposes `setScene(name)` and `freeze(bool)` for screenshotting. Scenes: `idle`, `mid-run` (long snake curving, fresh groove behind it, food visible), `trail-fade` (groove visibly at several ages), `golden` (golden food active), `death` (mid dust cloud), `gameover` (with a populated leaderboard and initials entry). `setTheme('light' | 'dark')` switches the palette instantly for captures. Built by constructing engine states directly and advancing the renderer's clock, so shots are deterministic.

## Testing

- **Unit (vitest)**: steering rotates toward target at the capped rate and takes the shortest way; reversal does not stall; path sampling respects spacing and trims to length; growth on eat; wall death; self-collision ignores the neck but triggers on a loop; golden food expiry; pause freezes time; restart keeps best; same seed + inputs → same run; pointer steering maps a ground point to the right heading; leaderboard keeps top 10 sorted, handles ties, rejects non-qualifying scores, recovers from corrupt storage.
- **E2E (playwright)**: existing tests updated — window opens from the bus, Escape closes, expand routes to `/snake`, `/snake` mounts a canvas with a WebGL context, best score persists.
- `pnpm typecheck`, `pnpm test`, `pnpm build` all pass (static export unaffected: the renderer is client-only and dynamically imported).

## Visual critic loop

1. **Checkpoint**: when the full visual build is in (all sections above implemented), a capture script (Playwright, headed-quality WebGL in Chromium) loads the dev server and captures each dev-hook scene at 1440×900 (`/snake`), 390×844 (mobile `/snake`), and the floating window at 1440×900 on the home page — in both light and dark themes.
2. **Critique**: a fresh subagent with no access to the code gets the brief (this Goal section), the screenshots, and a rubric: composition & framing, lighting & mood, sand material & trail groove readability (is "lingers → shrinks → gone" legible?), snake quality, food & effects, HUD legibility, cohesion with the site, and artifacts (aliasing, shadow acne, banding, seams, clipping). It returns issues ranked by severity (major / minor / nit) with the screenshot each applies to, and an overall 1–10 score.
3. **Iterate**: fix all major and the most valuable minor issues, re-capture, re-critique with a fresh critic (which sees the previous report, to check the fixes). Stop after 3 rounds, or earlier when there are no major issues and the score is 8 or higher.
4. Before/after screenshots and the critic reports are kept in the PR description; the images themselves are not committed.

## Out of scope

A trail that affects gameplay; a global/shared leaderboard (needs a backend); audio files or music tracks.
