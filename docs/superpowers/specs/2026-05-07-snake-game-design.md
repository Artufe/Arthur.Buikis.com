# Snake game — design

A PixiJS-rendered Snake easter egg, accessible only via the command palette (which spawns a draggable, OS-style floating window) and a `/snake` route (full-page version). Themed as a REPL/CRT terminal with light AI flair, fitting Arthur's Python/Rust/AI positioning. Both surfaces share one engine.

## Goals

- An easter egg that lands visually inside the first 5 seconds — recognizable as "this person codes" before the snake even moves.
- Earns the "AI developer" claim through small ambient details, not a forced gimmick.
- Genuine PixiJS-advanced surface area (custom GLSL filter, `Graphics`-driven body with rounded joins, `DisplacementFilter` shockwaves, GPU particles), not just "draw rectangles to a canvas."
- Plays cleanly on desktop with a keyboard, plays at all on mobile, persists a high score across visits.
- Zero impact on the rest of the site's bundle — PixiJS only ships in the snake page chunk.

## Non-goals

- Online leaderboard, accounts, or any backend (the site is a static export).
- A real AI pathfinder visualization — descoped to decorative neural flair only.
- Window minimize/maximize/resize, multi-instance windowing, or a generic windowing system. The expand button (`↗`) substitutes for maximize by routing to `/snake`.
- Pixel-level visual regression testing.

## Two surfaces, one engine

### Floating window (command palette)

Adding `play snake` to the command palette in the Meta group (arrow `▶`, keywords `game`, `easter egg`). Selecting it closes the palette and spawns a draggable window. Behavior:

- **Window chrome.** Title bar shows `> snake.py` on the left, `↗` (expand → routes to `/snake`) and `×` (close) on the right. Mono, hard-edged, matches the existing site language.
- **Drag.** Pointer events on the title bar move the window; viewport-clamped so it can't be dragged off-screen. Cursor changes to `grab`/`grabbing`.
- **Single instance.** If the window is already open, running `play snake` raises and focuses it instead of mounting a second copy.
- **Position persistence.** The last-known `{x, y}` is saved to `localStorage` under `snake.window.pos`; reopening lands at that position (clamped to current viewport).
- **Z-index.** Above page content, below the command palette overlay. The palette closes on action, so there's no live conflict.
- **Fixed size.** 560×640 on desktop. On `< 768px` the window becomes a fixed full-bleed sheet (drag disabled).
- **Lifecycle.** The window host is mounted globally in `app/layout.tsx` so the window survives route changes. Closing the window stops the engine, disposes the PixiJS app, and removes the canvas from the DOM.

### `/snake` route

A full-page version. Same engine, larger canvas. Hero shader is excluded on this route (added to `SHADER_EXCLUDED_ROUTES` in `components/hero-shader.tsx`) so the CRT is the only background. No window chrome — just the canvas, score, and side console.

### Discoverability

None. The command palette is the only surface that mentions it; there is no nav entry, no footer link, no on-page mention. The `/snake` route is reachable only by direct URL or the window's expand button.

## Visual engine — the PixiJS twist

Three layers stacked through PixiJS, all on a single `<canvas>`:

### CRT chassis (custom GLSL fragment filter)

A single `Filter` applied to the root stage. The fragment shader does, in this order:

1. Subtle barrel distortion (UV warp toward the screen edges).
2. Chromatic aberration: sample R and B channels with a tiny offset, G unchanged.
3. Scanlines: a `sin(uv.y * lines)` modulation, low amplitude.
4. Animated grain: hashed noise driven by a `uTime` uniform.
5. Edge vignette toward `#000`.

This is what the user sees *before* anything moves — the screen looks like a CRT terminal the moment it mounts. This single shader does ~80% of the visual work. The shader source lives in `components/snake/snake-shader-crt.ts` as an exported template string and is loaded into a `Filter` instance with the stage as its target.

### Snake body

A continuous rounded-joined polyline, drawn each frame to a `Graphics` object:

- The body is a sequence of grid cells (one per occupied cell) plus a tween-interpolated head position.
- Each frame, the renderer clears the `Graphics`, walks tail → head laying down `moveTo`/`lineTo` segments through cell centers, then strokes with `width = cellSize - gap`, `cap: 'round'`, `join: 'round'`.
- The rounded joins automatically produce a curved corner at every turn cell — the "transition on turns is smooth and the turning point is a curve" requirement.
- The head leads with a smoothly tweened position (linear interpolation between previous and current cell over the tick interval), so motion at low tick rates still feels fluid.
- Color: `--accent`, sampled from CSS at mount and on theme change. (Inside the canvas the palette is always dark-themed; see Theming.)

No per-segment glow filter, no glyph cycling. The CRT shader provides the texture.

### Neural flair

Small ambient details that earn the AI-developer angle without overplaying it:

- **Synapse-fire shockwave on `claude` pellet.** A `DisplacementFilter` whose displacement map is a small radial-gradient sprite is briefly attached to the stage and animated (radius grows, strength decays) over ~400ms. Simultaneously, a burst of ~30 GPU particles via `ParticleContainer` spawns at the head position and fades out.
- **Loss-curve corner widget.** A thin SVG-style line in the bottom-right of the canvas, drawn into a `Graphics` object, that slowly ticks down as score climbs. Pure decoration. Reads as "training loss."
- **Speed-boost shimmer on `async` pellet.** The CRT shader's chromatic-aberration uniform is briefly dialled up for ~300ms, producing a "warp" feel during the 3-second speed boost.

### Side console (DOM, not Pixi)

Right of the canvas on desktop. On mobile (`< 768px`) the console DOM is not rendered — the in-memory buffer still exists (engine-side) but the user only sees the canvas-overlay messages. Desktop layout: a vertical "REPL" with a fixed-height rolling buffer of the last 8 lines, mono, no scrollbar. Each pellet eaten appends one line. On game over, prints the panic strip.

```
>>> def def()
>>> import claude
>>> async run()
panic!: index out of bounds at line 12
```

### Reduced motion

Honored in two places, mirroring the hero shader:

- The renderer disables: shockwave displacement, particle bursts, chromatic-aberration spikes on speed boost, and the head-tween interpolation (head snaps to cell on reduced-motion).
- The CRT shader's grain and aberration uniforms are zeroed; scanlines and vignette stay (they don't move). Still playable, still readable.

### Theming

The canvas is always dark internally — the CRT only sells on black. On light theme the canvas keeps its own dark palette; the surrounding UI (window chrome, side console) stays light. This is a one-direction override: we don't try to make the CRT light-mode compatible.

## Mechanics

- **Grid.** 22×22 in the floating window, ~28×28 on `/snake`. Cell size derived from canvas size (`floor(canvasSize / gridCount)`).
- **Tick rate.** Starts at 8 cells/sec. After each pellet eaten, `tickRate *= 1.06`, clamped to 14/sec. Resets on death.
- **Direction queue.** Inputs are queued (single slot) so a quick `↑→` mid-tick lands cleanly. A queued opposing input (180° self-kill) is silently dropped.
- **Controls.**
  - Desktop: `↑↓←→` and `WASD` to steer. `space` pauses. `r` restarts. `esc` closes the window (full-page route ignores `esc`).
  - Mobile: swipe to steer (pointer events on the canvas; ≥ 24px primary-axis displacement wins). On-screen pause and restart icons in the title bar / canvas overlay. `esc` only fires on hardware keyboards.
  - Inputs while another `<input>`/`<textarea>` has focus are ignored, mirroring the existing palette behavior.
- **Pellets.** One on the board at a time, spawned at a uniformly random unoccupied cell. Type weighted:
  - **Plain (~70%).** Glyph drawn from the rotation `def`, `fn`, `let`, `await`, `pub`, `→`, `λ`, `:=`. +1 score.
  - **`async` (~12%).** 3-second speed boost (`tickRate *= 1.3` for the duration, then restored). +1 score. Console: `>>> async run()`.
  - **`claude` (~12%).** +3 score. Triggers the displacement shockwave + particle burst. Console: `>>> import claude`.
  - **`panic!` (~6%).** Red glyph. Eating it ends the run. Console: `panic!: index out of bounds at line {{score}}`. Spawn-time guard: if the snake's head currently has only one legal next-move cell (the other three are walls or body), the pellet at that cell is never `panic!` — the type is re-rolled to a non-`panic!` flavor. Guarantees a survivable next tick.
- **Score and best.** Score displayed in the canvas top-left. Best persists in `localStorage` under `snake.best`. The persisted value is updated at game-over (and only at game-over) when `score > best`. localStorage access is wrapped in a try/catch — failures (private mode, quota) silently fall back to in-memory best.
- **Game over.** On wall, self, or `panic!` collision: a ~300ms CRT glitch flash (a uniform pulse on the shader's aberration + grain), the side console prints the panic line, and the canvas overlays:

  ```
  panic!: index out of bounds at line {{score}}
  best: {{best}}
  press r to restart
  ```

- **Pause.** `space` toggles. Dimmed canvas (40% alpha overlay) and a `// paused` text in the center. Reduced motion is still respected during pause.

## Architecture

### File layout

```
app/snake/page.tsx                            # full-page route; mounts <SnakeCanvas variant="page" />
components/snake/
  snake-window.tsx                            # draggable floating window; mounts <SnakeCanvas variant="window" />
  snake-window-host.tsx                       # global mount point; subscribes to snake-bus to show/hide
  snake-canvas.tsx                            # 'use client'; lazy-imports pixi + renderer; sizes the canvas
  snake-engine.ts                             # pure game state (no Pixi, no DOM)
  snake-renderer.ts                           # all PixiJS — stage, CRT filter, body Graphics, particles
  snake-shader-crt.ts                         # GLSL fragment string + uniform schema for the CRT filter
  snake-console.tsx                           # the REPL side panel (DOM)
  snake-types.ts                              # shared types: GameState, Pellet, Direction, etc.
lib/commands.ts                               # add 'play snake' command + new action type 'snake'
lib/snake-bus.ts                              # tiny event bus to open/raise/close the window from the palette
components/command-palette.tsx                # handle the 'snake' action by dispatching on snake-bus
components/hero-shader.tsx                    # add '/snake' to SHADER_EXCLUDED_ROUTES
app/layout.tsx                                # mount <SnakeWindowHost /> globally
docs/superpowers/specs/2026-05-07-snake-game-design.md   # this spec
```

### Engine / renderer isolation

- `snake-engine.ts` is a **pure module**: types, initial state, `step(state, input, dt) → state`, `spawnPellet(state) → state`, collision tests, scoring. No DOM, no Pixi, no React. About 150 lines.
- `snake-renderer.ts` owns the PixiJS `Application` and exports:
  - `mount(canvas: HTMLCanvasElement, opts: { gridCount, cellSize, reducedMotion })` → handle
  - `render(state: GameState)` — called every animation frame; consumes engine state, never mutates it
  - `triggerShockwave(at: GridCell)` — fires the displacement + particle burst
  - `setReducedMotion(on: boolean)`
  - `dispose()`

  The renderer is the only file allowed to import from `pixi.js`.
- `snake-canvas.tsx` glues the two together: owns the React lifecycle, runs the engine `tick` loop on `requestAnimationFrame`, calls `renderer.render(state)` after each tick.

### PixiJS lazy load

`snake-canvas.tsx` is dynamically imported in both `app/snake/page.tsx` and `components/snake/snake-window.tsx` via `next/dynamic({ ssr: false })`. Inside `snake-canvas.tsx`, the `pixi.js` import lives inside `useEffect`, ensuring it never runs at build time and never lands in the main bundle. The static-export build still works.

### Floating window

Hand-rolled, ~80 lines. A `position: fixed` div with pointer-down on the title bar starting a drag, pointer-move updating `style.transform: translate(x, y)` (transform is cheaper than `top/left`), pointer-up ending the drag. Viewport-clamping on each move. Single-instance enforcement: the window-host context tracks whether the window is open and ignores duplicate open events (raises the existing window's z-index briefly as a "focus" cue instead). No `react-rnd` dependency.

### Command palette integration

A new entry in the `CommandAction` union: `{ type: 'snake' }`. The palette's `runAction` dispatches `openSnake()` on the bus and closes itself. The window host subscribes to the bus and toggles its mounted state.

### Dependencies

- **Add:** `pixi.js@^8` — the only required new dep.
- **Maybe add:** `@pixi/particle-emitter` if `ParticleContainer` alone proves too coarse for the synapse burst. Decide during build; default to no extra dep.
- **Do not add:** `react-rnd`, `framer-motion`, `gsap`, particle libraries beyond the above.

### Tests

- **`snake-engine.spec.ts`** (vitest): pure-function tests covering wall collision, self collision, pellet effects (`claude` adds 3, `async` boosts tick rate), the panic-pellet placement guard, score scaling, the `localStorage` high-score update.
- **`tests/snake.spec.ts`** (Playwright): `/snake` mounts a `<canvas>`; opening the palette and running `play snake` mounts the floating window; `esc` closes the window; reloading after a high-score retains it via `localStorage`. No pixel testing.

## Risks and mitigations

- **PixiJS bundle size in the snake chunk.** PixiJS v8 is ~300kb gzipped. Mitigated by lazy-loading the entire renderer + Pixi inside `snake-canvas.tsx`, never in the main bundle. The user only pays this cost when they actually open the easter egg.
- **CRT shader on low-end mobile GPUs.** The custom filter could be expensive on old devices. Mitigation: detect via `navigator.hardwareConcurrency < 4` or a quick benchmark on mount; fall back to `chromaticAberration = 0`, `grain = 0` (scanlines stay — they're cheap). Decide during implementation; default to "ship the full filter, watch field reports."
- **Static export + dynamic import.** Confirmed works (see existing `command-palette-lazy.tsx`). The dynamic chunk will be a separate JS file in `out/_next/static/chunks/`.
- **Floating window over the rest of the app.** The window must persist across route changes, so it's mounted globally. Risk: it leaks into pages where it doesn't belong if a user navigates while it's open. Mitigation: the window stays open on route change by design (matches OS behavior); the close button is always there.
