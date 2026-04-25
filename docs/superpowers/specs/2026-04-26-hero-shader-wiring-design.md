# Hero shader — wiring design

Wire the staged WebGL plasma shader (`public/hero-shader.js`, `docs/hero-shader.md`) into the Next.js app so it renders behind the hero on both themes, fades out as the user scrolls past the hero, and respects reduced-motion.

## Goals

- Atmospheric, low-intensity plasma backdrop that frames the hero headline and the system monitor panel.
- Themes both look intentional. The shader's palette swaps with `next-themes` so light mode (paper + rust) and dark mode (near-black + amber) each get a tuned look — not a dark-only effect lazily ported.
- Doesn't bleed visually into the rest of the page. Canvas is fixed full-viewport for performance, but its opacity fades out as the user leaves the hero.
- Respects `prefers-reduced-motion`: drops `speed` to `0` and lowers intensity, leaving a still gradient instead of unmounting.
- Per-mount randomness on the wave emitter phases so each visit looks subtly different — same palette, slightly different drift trajectories. Subtle by design.
- Calm/vivid intensity toggle, surfaced through the existing command palette (no new visible UI), persisted across visits via `localStorage`.
- Zero impact on first contentful paint or hydration; the canvas is loaded after interactive.

## Non-goals

- Adding the other four wallpaper presets (aurora, field, lattice, caustics) from the source repo. Tracked separately if we want them later.
- Changes to the hero markup beyond a single `data-hero-region` attribute used as a measurement target.

## Architecture

```
<body>
  <ThemeProvider>
    <HeroShader />        // new — fixed canvas at z:-1
    <Gridlines />         // existing — z:0
    <Grain />             // existing — z:1
    <Nav />
    <main>{children}</main>// existing — z:10
    ...
  </ThemeProvider>
</body>
```

The canvas sits at `z-index: -1`, painting above the body's background color but below every existing fixed overlay. No changes to existing z-stacking are needed.

### Components

#### `components/hero-shader.tsx` (new, `'use client'`)

Single client component. Responsibilities:

1. Render a `<canvas>` and an inline `next/script` (`strategy="afterInteractive"`) that loads `/hero-shader.js`.
2. Once the IIFE has registered `window.HeroShader`, call `mount(canvas, opts)` and store the returned handle. Pass an `opts.seed = Math.random() * 2π` so each visit gets a unique starting phase for the wave emitters.
3. Subscribe to `useTheme()` from `next-themes`; on `resolvedTheme` change, call `handle.set({ deep, mid, accent, intensity })` with the theme-specific palette, multiplied by the current calm/vivid factor. No re-mount.
4. Subscribe to plasma-mode changes via `lib/plasma-bus.ts`. On change, call `handle.set({ intensity })` with the new factor applied.
5. On first mount, check `matchMedia('(prefers-reduced-motion: reduce)')`; if it matches, additionally `handle.set({ speed: 0, intensity: 0.35 })`. Reduced-motion overrides calm/vivid — accessibility wins.
6. Install a passive `scroll` listener (rAF-throttled). On each frame: read `window.scrollY` and the cached hero height, set `canvas.style.opacity = clamp(1 - scrollY / heroHeight, 0, 1)`. CSS transition smooths the visual change.
7. Hero height is measured once via `document.querySelector('[data-hero-region]')`, cached, re-measured on `resize`.
8. Cleanup on unmount: `handle.stop()`, unsubscribe from plasma-bus, remove scroll/resize listeners.

Canvas inline style: `position: fixed; inset: 0; width: 100%; height: 100%; z-index: -1; pointer-events: none; transition: opacity 200ms ease`.

#### `public/hero-shader.js` (existing, edit in place)

Four changes:

1. **Palette uniforms.** Add `uDeep`, `uMid`, `uAccent` (vec3) uniforms. Replace the hardcoded `deep`/`mid`/`accent` constants in `main()` with reads from these uniforms. Defaults seeded to the dark-mode palette so a vanilla `HeroShader.mount(canvas)` call still works for any other consumer.
2. **Vignette mode swap.** Change `col *= smoothstep(0.95, 0.25, dot(q,q))` to `col = mix(uDeep, col, smoothstep(0.95, 0.25, dot(q,q)))`. Corners fade to the deep palette color, not to black. This is what makes light-mode legible.
3. **Drop `uHue`/`hueShift`.** No longer needed — palette is now passed explicitly. Remove the uniform, the helper, and the `hueShift(...)` call. Remove `hue` from the options state and runtime API.
4. **Per-mount phase seed.** Add a `uSeed` (float) uniform, added into the wave emitter phase math: `cos(t*0.4 + fi*1.7 + uSeed)` and `sin(t*0.5 + fi*2.3 + uSeed*1.3)`. Defaults to `0` so vanilla consumers see no change. Wrapper passes `Math.random() * 6.2831853` per mount.

Public API after the change:

```ts
HeroShader.mount(canvas, opts?) → { set(partial), stop() }
opts: { intensity?: number, speed?: number, grain?: number, seed?: number,
        deep?: [r,g,b], mid?: [r,g,b], accent?: [r,g,b],
        eventTarget?: EventTarget }
```

The `0..1` rgb tuples are written into `vec3` uniforms each frame.

#### `lib/plasma-bus.ts` (new)

Tiny pub-sub plus localStorage persistence, mirroring `lib/palette-bus.ts`. Exports:

- `getPlasmaMode(): 'calm' | 'vivid'` — reads from `localStorage`, defaults to `'vivid'`.
- `setPlasmaMode(mode)` — writes to `localStorage` and dispatches a `plasma:mode` custom event on `window`.
- `onPlasmaModeChange(handler)` — subscribes; returns an unsubscribe function.

Lives in `lib/` because both the wrapper (consumer) and the command palette (producer) need it; no circular import risk.

#### `lib/commands.ts` (existing, edit)

Add a new action type `{ type: 'plasma'; value: 'calm' | 'vivid' }` to the `CommandAction` union. Add two commands to the `commands` array under the `Meta` group:

```ts
{ id: 'plasma-calm',  label: 'plasma calm',  group: 'Meta', arrow: '◌', hint: 'low intensity',     action: { type: 'plasma', value: 'calm' } },
{ id: 'plasma-vivid', label: 'plasma vivid', group: 'Meta', arrow: '●', hint: 'default intensity', action: { type: 'plasma', value: 'vivid' } },
```

#### `components/command-palette.tsx` (existing, edit)

Add a `case 'plasma'` branch to the `runAction` switch that calls `setPlasmaMode(cmd.action.value)` and closes the palette. The "current mode" indicator (analogous to the existing `current` hint on the active theme) is out of scope — palette commands run blind, the user sees the effect.

#### `app/layout.tsx` (existing, edit)

Render `<HeroShader />` as the first child of `<ThemeProvider>`, before `<Gridlines />`. No other changes.

#### `components/hero.tsx` (existing, edit)

Add `data-hero-region` to the existing `<section>`. One-line attribute change.

## Theme palette mapping

Source of truth lives in `app/globals.css`. Mirrored in the wrapper component as a constant:


| Theme | `deep` (bg) | `mid` (bg-muted) | `accent`  | `intensity` |
| ----- | ----------- | ---------------- | --------- | ----------- |
| dark  | `#0F0F0F`   | `#1A1F2E` *      | `#FFB84D` | `0.55`      |
| light | `#F7F5F1`   | `#EBE5DE`        | `#B25C0D` | `0.32`      |


 `bg-muted` in dark mode (`#17161480`) is alpha-channel; `mid` for the shader is a slightly cool-shifted opaque variant chosen to keep the cool plasma feel without diverging from brand. Light-mode `mid` matches the existing `--bg-muted` exactly.

The light-mode `intensity` is roughly half of dark because the palette delta from `deep` (cream) to `accent` (rust) is much smaller than dark's `deep` (near-black) to `accent` (amber). At `0.55` in light mode, the rust splotches dominate; `0.32` keeps it atmospheric. Will be tuned live during implementation.

**Calm/vivid factor.** The values above represent `vivid` (default). The `calm` mode multiplies them by `0.55` (so dark-calm `≈ 0.30`, light-calm `≈ 0.18`). The factor is applied in the wrapper before passing to `handle.set()`; the shader sees only the final number.

## Reduced-motion handoff

On mount, if `matchMedia('(prefers-reduced-motion: reduce)').matches`, call `handle.set({ speed: 0, intensity: 0.35 })`. This freezes the plasma's drift but keeps the texture visible — same approach as the rest of the site (`globals.css:149-158`).

We do not subscribe to changes in the reduced-motion preference at runtime. A user toggling OS-level reduced-motion mid-session is rare; a re-render on `next-themes` toggle does not re-evaluate the media query. If this turns out to matter, we can add a `MediaQueryList` listener — out of scope for now.

## Scroll fade

Algorithm:

```js
const heroH = heroEl.getBoundingClientRect().height;
const onScroll = () => {
  rafId ??= requestAnimationFrame(() => {
    const r = Math.max(0, Math.min(1, 1 - window.scrollY / heroH));
    canvas.style.opacity = String(r);
    rafId = null;
  });
};
```

- Hero height measured once on mount and re-measured on `resize`.
- Listener is `passive: true`.
- Below `scrollY === heroHeight` opacity is `0` — the canvas is still rendering but invisible. The shader's existing `IntersectionObserver` doesn't help here (the canvas is full-viewport, never offscreen), so it keeps drawing. Acceptable: ~0.4 ms/frame per the doc, and on most pages users scroll back up before parking.
- If this becomes a measurable cost, a follow-up can `running = false` once opacity hits 0.

## Risks and verification

- **Stacking — `z-[-1]` above body bg.** Body has `background: var(--bg)` but does not establish a stacking context (no `position`, `transform`, `opacity`, etc. that would). A negative-z-index child paints above the body's background. Verify visually on first run.
- **Light-mode contrast at `intensity: 0.32`.** Subjective; will tune by eye. The risk is rust-tinted bright spots reducing the contrast of `#0F0F0F` body text against the cream background — body copy must remain comfortably readable wherever a bright shader spot lands.
- **Theme change without flash.** `handle.set()` writes new uniforms on the next frame — no re-mount. Should be a soft cross-fade rather than a flash. Verify on toggle.
- **Hydration / SSR.** Wrapper is `'use client'`; canvas renders server-side as an empty element (no children) — no hydration mismatch risk. Script loads after interactive, so no FCP impact.
- **Static export.** Site is built with `next build` and exported (per project config). `next/script` with `afterInteractive` is supported in static export. The script file is served from `public/`, which static export ships verbatim.
- **First-paint plasma flash before persisted mode loads.** `localStorage` is only available client-side, so on cold load the wrapper mounts at `vivid` intensity and immediately switches to `calm` if persisted. Cheapest fix: read `localStorage` on mount before the first `handle.set` call so the very first frame already uses the right factor. Plan does this.
- **Reduced-motion vs calm/vivid ordering.** Reduced-motion override must run AFTER any plasma-mode change, otherwise a `plasma vivid` toggle would re-enable motion. Wrapper consolidates both into one `applyState` helper that always re-checks reduced-motion last.

## Testing

Manual verification on `localhost:3000`:

1. Dark theme on load: plasma visible behind hero, vignette fades to near-black at edges, headline and monitor remain legible.
2. Toggle to light: palette swaps live; cream + rust; corners fade to cream, not black.
3. Scroll down past hero: canvas opacity tapers to 0 by the time the work section is in view.
4. `prefers-reduced-motion: reduce` (DevTools rendering panel): plasma is static, no drift.
5. Open command palette (`/` or `cmd+K`), run `plasma calm` — intensity drops noticeably. Run `plasma vivid` — back to default. Reload — chosen mode persists.
6. With reduced-motion still on: running `plasma vivid` does NOT re-enable motion or jump to full intensity. Reduced-motion wins.
7. Multiple page loads in dark theme show subtly different drift trajectories (the per-mount phase seed at work).
8. No console errors. No visible flash on theme toggle. No layout shift.

No automated tests for this change. The visual nature of the work and the WebGL surface make integration tests low-value here.

## Out of scope (follow-ups)

- Light-mode shader tuning beyond the initial `intensity: 0.32` if it doesn't sit right.
- Stopping the RAF when `opacity === 0` to save the 0.4 ms/frame.
- Wiring the other four shader presets from the source repo.
- "Current mode" badge on the plasma commands in the palette (analogous to the `current` hint on the active theme command).

